#!/usr/bin/env node
// Sentinel CLI — read-only wallet approval auditor.
// Usage:
//   sentinel scan <address> [--chain 56|1|all] [--blocks N] [--json] [--out file]
//   sentinel watch <address> [--chain 56|1|all] [--interval seconds] [--blocks N]
//   sentinel revoke <token> <spender>
//   sentinel decode <calldata>
//   sentinel --help
//
// Sentinel NEVER signs, NEVER broadcasts, NEVER connects a wallet. The
// `revoke` command only prints calldata for the user to sign themselves.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import {
  RateLimitError,
  buildRevokeCalldata,
  canonicalReportString,
  createRpcClient,
  decodeApproveCalldata,
  explainRevoke,
  getChain,
  isAddress,
  normalizeAddress,
  renderMarkdownReport,
  renderTextReport,
  reportToJson,
  runCycle,
  watch,
} from "../src/index.js";

const VERSION = "1.0.0";

function help() {
  console.log(`Sentinel ${VERSION} — read-only ERC-20 approval auditor.

Usage:
  sentinel scan <address> [--chain 56|1|all] [--blocks N] [--json] [--markdown] [--out file]
  sentinel watch <address> [--chain 56|1|all] [--interval seconds] [--blocks N]
  sentinel revoke <token> <spender>
  sentinel decode <calldata>
  sentinel --help

Notes:
  - Read-only. Sentinel never signs, broadcasts, or connects a wallet.
  - scan defaults to both chains (BSC 56 + Ethereum 1).
  - --blocks sets the Approval-log window (default: 500k BSC / 50k Ethereum).
  - Revoke calldata is printed for you to review and sign in your own wallet.
  - On RPC rate limits the scan stops and reports PARTIAL instead of hammering.`);
}

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next != null && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function parseChains(value) {
  if (value == null || value === "all") return [56, 1];
  const id = Number(value);
  if (![56, 1].includes(id)) throw new Error(`--chain must be 56, 1, or all (got ${value})`);
  return [id];
}

function rpcForChain(chainId) {
  const chain = getChain(chainId);
  return createRpcClient(chain.rpcUrls);
}

function reportHash(report) {
  return createHash("sha256").update(canonicalReportString(report)).digest("hex");
}

async function cmdScan(positional, flags) {
  const address = positional[1];
  if (!isAddress(address)) throw new Error("scan requires a valid EVM address");
  const chainIds = parseChains(flags.chain);
  const blocks = flags.blocks != null ? Number(flags.blocks) : undefined;
  if (blocks != null && (!Number.isInteger(blocks) || blocks <= 0)) throw new Error("--blocks must be a positive integer");

  const { report, recommendations } = await runCycle(rpcForChain, normalizeAddress(address), chainIds, {
    blocks,
    onProgress: flags.json ? null : ({ from, to }) => {
      process.stderr.write(`\rscanning logs ${from}-${to}...`);
    },
  });
  if (!flags.json) process.stderr.write("\r");
  const hash = reportHash(report);
  const urgent = recommendations.filter((r) => r.action === "revoke-now");

  let output;
  if (flags.json) {
    output = reportToJson({ ...report, reportHash: hash });
  } else if (flags.markdown) {
    output = `${renderMarkdownReport(report)}\n\n**Report hash (SHA-256 of canonical report):** \`${hash}\`\n`;
  } else {
    output = `${renderTextReport(report)}\n\nreport hash (SHA-256 of canonical report): ${hash}\n`;
    if (urgent.length > 0) {
      output += `\n${urgent.length} approval(s) need review — revoke calldata is listed above. Review and sign in your own wallet.\n`;
    }
  }
  if (flags.out) {
    writeFileSync(flags.out, output);
    console.log(`wrote ${flags.out}`);
  } else {
    console.log(output);
  }
}

async function cmdWatch(positional, flags) {
  const address = positional[1];
  if (!isAddress(address)) throw new Error("watch requires a valid EVM address");
  const chainIds = parseChains(flags.chain);
  const intervalSeconds = flags.interval != null ? Number(flags.interval) : 300;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 30) throw new Error("--interval must be >= 30 seconds");
  const blocks = flags.blocks != null ? Number(flags.blocks) : undefined;
  console.log(`Watching ${normalizeAddress(address)} on chain(s) ${chainIds.join(", ")} every ${intervalSeconds}s. Ctrl+C to stop. Read-only; nothing is signed.`);
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  await watch(rpcForChain, normalizeAddress(address), chainIds, {
    intervalMs: intervalSeconds * 1000,
    signal: controller.signal,
    scanOptions: { blocks },
    onCycle: async ({ cycle, report, recommendations, diff }) => {
      const stamp = new Date().toISOString();
      const urgent = recommendations.filter((r) => r.action === "revoke-now").length;
      console.log(`\n[cycle ${cycle} @ ${stamp}] live approvals: ${report.chains.reduce((n, c) => n + c.approvals.length, 0)} | revoke-now: ${urgent}${report.partial ? " | PARTIAL" : ""}`);
      if (diff) {
        for (const a of diff.added) console.log(`  NEW: ${a.tokenSymbol ?? a.token} -> ${a.spender} (${a.level} ${a.score})`);
        for (const a of diff.removed) console.log(`  GONE: ${a.tokenSymbol ?? a.token} -> ${a.spender}`);
        for (const { before, after } of diff.changed) console.log(`  CHANGED: ${after.tokenSymbol ?? after.token} -> ${after.spender} (score ${before.score} -> ${after.score})`);
        if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) console.log("  no changes since last cycle");
      }
      for (const w of report.warnings) console.log(`  warning: ${w}`);
    },
  });
  console.log("watch stopped.");
}

function cmdRevoke(positional) {
  const [token, spender] = [positional[1], positional[2]];
  if (!isAddress(token) || !isAddress(spender)) throw new Error("revoke requires a token address and a spender address");
  const calldata = buildRevokeCalldata(spender);
  console.log(`token:   ${normalizeAddress(token)}`);
  console.log(`spender: ${normalizeAddress(spender)}`);
  console.log(`calldata: ${calldata}`);
  console.log("");
  console.log(explainRevoke({ token: normalizeAddress(token), spender: normalizeAddress(spender) }));
  console.log("");
  console.log("Sentinel never signs. Paste this calldata into your wallet's contract-interaction flow only after verifying the checks above.");
}

function cmdDecode(positional) {
  const calldata = positional[1];
  if (!calldata) throw new Error("decode requires calldata");
  const decoded = decodeApproveCalldata(calldata);
  if (!decoded) {
    console.log("not a well-formed approve(address,uint256) payload");
    process.exitCode = 1;
    return;
  }
  console.log(`function: approve(address spender, uint256 amount)`);
  console.log(`spender:  ${decoded.spender}`);
  console.log(`amount:   ${decoded.amount.toString(10)}${decoded.amount === 0n ? " (REVOKE — sets allowance to zero)" : ""}`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command] = positional;
  if (command == null || flags.help || command === "--help" || command === "-h") {
    help();
    return;
  }
  try {
    if (command === "scan") await cmdScan(positional, flags);
    else if (command === "watch") await cmdWatch(positional, flags);
    else if (command === "revoke") cmdRevoke(positional);
    else if (command === "decode") cmdDecode(positional);
    else {
      console.error(`unknown command: ${command}`);
      help();
      process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      console.error(`\nStopped: ${err.message}`);
      console.error("Sentinel does not retry against rate limits. Try again later with a smaller --blocks window.");
      process.exitCode = 3;
      return;
    }
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}

main();
