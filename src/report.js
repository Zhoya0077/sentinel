// Report rendering: human-readable text/markdown plus a canonical JSON form
// whose SHA-256 hash lets anyone verify a report by re-running the same
// read-only scan. The hash function itself lives outside the core (Node
// crypto in the CLI, SubtleCrypto in the browser demo) so this module stays
// platform-neutral.
//
// Canonical form rules: sorted object keys, BigInt rendered as decimal
// strings, arrays in score order, no timestamps inside the hashed payload
// (scannedAt varies run to run; the block range is the stable anchor).

import { formatAmount } from "./codec.js";
import { formatUsdCents } from "./risk.js";
import { explorerAddressUrl, explorerTxUrl, getChain } from "./chains.js";

export function canonicalize(value) {
  if (typeof value === "bigint") return value.toString(10);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
  return out;
}

export function canonicalReportString(report) {
  const { scannedAt, warnings, partial, ...rest } = report;
  void scannedAt;
  void warnings;
  void partial;
  const payload = canonicalize(rest);
  return JSON.stringify(payload);
}

export function countByLevel(approvals) {
  const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const a of approvals) counts[a.level] = (counts[a.level] ?? 0) + 1;
  return counts;
}

function approvalLines(a, chain) {
  const symbol = a.tokenSymbol ?? "UNKNOWN";
  const amountText = a.unlimited ? "UNLIMITED" : formatAmount(a.allowance, a.decimals);
  const balanceText = formatAmount(a.balance, a.decimals);
  const usd = a.exposureUsdCents == null ? "n/a" : `~${formatUsdCents(a.exposureUsdCents)} (approx.)`;
  const spenderText = a.spenderLabel ? `${a.spender} (${a.spenderLabel})` : a.spender;
  const age = a.ageDays == null ? "unknown age" : `${a.ageDays} days old`;
  return [
    `[${a.level} ${a.score}] ${symbol} -> ${spenderText}`,
    `  token:    ${a.token} (${explorerAddressUrl(chain, a.token)})`,
    `  allowance: ${amountText} ${symbol} | balance: ${balanceText} ${symbol} | exposure: ${usd}`,
    `  age: ${age} | discovered via: ${a.discoveredVia}${a.earliestTx ? ` | first seen: ${explorerTxUrl(chain, a.earliestTx)}` : ""}`,
    `  why: ${a.reasons.join("; ")}`,
    `  revoke calldata (approve(spender, 0)): ${a.revokeCalldata}`,
  ];
}

export function renderTextReport(report) {
  const lines = [];
  lines.push(`Sentinel approval report for ${report.owner}`);
  lines.push(`scanned at ${report.scannedAt}${report.partial ? " — PARTIAL (stopped early, see warnings)" : ""}`);
  for (const chainReport of report.chains) {
    const chain = getChain(chainReport.chainId);
    lines.push("");
    lines.push(`== ${chain.name} (chain ${chainReport.chainId}) ==`);
    lines.push(`log window: blocks ${chainReport.scannedFromBlock}-${chainReport.scannedToBlock} | pairs checked: ${chainReport.pairsConsidered}`);
    if (chainReport.approvals.length === 0) {
      lines.push("No live approvals found in the scanned window.");
    } else {
      const counts = countByLevel(chainReport.approvals);
      lines.push(`live approvals: ${chainReport.approvals.length} (CRITICAL ${counts.CRITICAL}, HIGH ${counts.HIGH}, MEDIUM ${counts.MEDIUM}, LOW ${counts.LOW})`);
      for (const a of chainReport.approvals) lines.push(...approvalLines(a, chain));
    }
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("warnings:");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  lines.push("");
  lines.push("Sentinel is read-only: it never signs, broadcasts, or connects a wallet. Revoke calldata above must be reviewed and signed in your own wallet.");
  return lines.join("\n");
}

export function renderMarkdownReport(report) {
  const lines = [];
  lines.push(`# Sentinel approval report`);
  lines.push("");
  lines.push(`**Wallet:** \`${report.owner}\`  `);
  lines.push(`**Scanned:** ${report.scannedAt}${report.partial ? " — **PARTIAL (stopped early)**" : ""}`);
  for (const chainReport of report.chains) {
    const chain = getChain(chainReport.chainId);
    lines.push("");
    lines.push(`## ${chain.name} (chain ${chainReport.chainId})`);
    lines.push("");
    lines.push(`Log window: blocks ${chainReport.scannedFromBlock}–${chainReport.scannedToBlock} · pairs checked: ${chainReport.pairsConsidered}`);
    lines.push("");
    if (chainReport.approvals.length === 0) {
      lines.push("No live approvals found in the scanned window.");
      continue;
    }
    const counts = countByLevel(chainReport.approvals);
    lines.push(`Live approvals: **${chainReport.approvals.length}** (CRITICAL ${counts.CRITICAL} · HIGH ${counts.HIGH} · MEDIUM ${counts.MEDIUM} · LOW ${counts.LOW})`);
    lines.push("");
    lines.push("| Risk | Token | Spender | Allowance | Balance | Exposure (approx.) | Age |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const a of chainReport.approvals) {
      const amountText = a.unlimited ? "UNLIMITED" : formatAmount(a.allowance, a.decimals);
      const usd = a.exposureUsdCents == null ? "n/a" : formatUsdCents(a.exposureUsdCents);
      const spender = a.spenderLabel ? `${a.spender.slice(0, 10)}… (${a.spenderLabel})` : `${a.spender.slice(0, 10)}…`;
      lines.push(
        `| ${a.level} ${a.score} | ${a.tokenSymbol ?? "UNKNOWN"} | ${spender} | ${amountText} | ${formatAmount(a.balance, a.decimals)} | ${usd} | ${a.ageDays == null ? "?" : a.ageDays + "d"} |`,
      );
    }
    lines.push("");
    lines.push("### Revoke calldata");
    lines.push("");
    lines.push("Review each payload and sign it in your own wallet. Sentinel never signs.");
    lines.push("");
    for (const a of chainReport.approvals) {
      lines.push(`- **${a.tokenSymbol ?? "UNKNOWN"}** → \`${a.spender}\`: \`${a.revokeCalldata}\``);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("");
    lines.push("## Warnings");
    lines.push("");
    for (const w of report.warnings) lines.push(`- ${w}`);
  }
  return lines.join("\n");
}

/** JSON-safe form of a report (BigInt -> decimal strings). */
export function reportToJson(report) {
  return JSON.stringify(canonicalize(report), null, 2);
}
