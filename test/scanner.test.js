import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_TOPIC, MAX_UINT256, SELECTORS } from "../src/codec.js";
import { RateLimitError } from "../src/rpc.js";
import { scanAll, scanChain } from "../src/scanner.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // decimals 6, symbol TOKA (ABI string)
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"; // decimals 18, symbol TOKB (bytes32)
const EOA_SPENDER = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x10ed43c718714eb63d5aa57b78b54704e256024e"; // known PancakeSwap router

const word = (n) => "0x" + BigInt(n).toString(16).padStart(64, "0");
const topicAddr = (a) => "0x" + "0".repeat(24) + a.slice(2);

function abiString(text) {
  const data = Buffer.from(text).toString("hex").padEnd(64, "0");
  const offsetWord = "0".repeat(62) + "20"; // 0x20
  const lengthWord = "0".repeat(63) + text.length.toString(16);
  return "0x" + offsetWord + lengthWord + data;
}
function bytes32String(text) {
  return "0x" + Buffer.from(text).toString("hex").padEnd(64, "0");
}

const NOW = Math.floor(Date.now() / 1000);

/** Fake RPC implementing the methods the scanner uses. */
function fakeRpc({ logs = [], allowances = {}, balances = {}, blockNumber = 1000, failWith = null } = {}) {
  const metas = {
    [TOKEN_A]: { decimals: 6, symbol: abiString("TOKA") },
    [TOKEN_B]: { decimals: 18, symbol: bytes32String("TOKB") },
  };
  return {
    async call(method, params = []) {
      if (failWith) throw failWith;
      if (method === "eth_blockNumber") return "0x" + blockNumber.toString(16);
      if (method === "eth_chainId") return "0x38";
      if (method === "eth_getLogs") return logs;
      if (method === "eth_getBlockByNumber") {
        const n = parseInt(params[0], 16);
        const ageDays = n <= 100 ? 200 : 5;
        return { timestamp: "0x" + (NOW - ageDays * 86400).toString(16) };
      }
      if (method === "eth_getCode") {
        return params[0].toLowerCase() === EOA_SPENDER ? "0x" : "0x60006000";
      }
      if (method === "eth_call") {
        const { to, data } = params[0];
        const selector = data.slice(0, 10);
        const token = to.toLowerCase();
        if (selector === SELECTORS.decimals) {
          return metas[token] ? word(metas[token].decimals) : "0x";
        }
        if (selector === SELECTORS.symbol) {
          return metas[token] ? metas[token].symbol : "0x";
        }
        if (selector === SELECTORS.name) return "0x";
        if (selector === SELECTORS.allowance) {
          // data = 0x + selector(8) + owner word(64) + spender word(64);
          // spender address = last 40 chars of the second word (indices 98..138).
          const spender = "0x" + data.slice(98, 138).toLowerCase();
          return word(allowances[`${token}:${spender}`] ?? 0n);
        }
        if (selector === SELECTORS.balanceOf) {
          return word(balances[token] ?? 0n);
        }
        return "0x";
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function approvalLog(token, spender, value, blockNumber, tx = "0x" + "cd".repeat(32)) {
  return {
    address: token,
    topics: [APPROVAL_TOPIC, topicAddr(OWNER), topicAddr(spender)],
    data: word(value),
    blockNumber: "0x" + blockNumber.toString(16),
    transactionHash: tx,
    logIndex: "0x0",
  };
}

const noPrices = { fetchImpl: async () => ({ ok: true, json: async () => ({}) }) };

describe("scanner", () => {
  it("finds a live unlimited approval, scores it, and attaches revoke calldata", async () => {
    const rpc = fakeRpc({
      logs: [approvalLog(TOKEN_A, EOA_SPENDER, MAX_UINT256, 50)],
      allowances: { [`${TOKEN_A}:${EOA_SPENDER}`]: MAX_UINT256 },
      balances: { [TOKEN_A]: 2500000n },
    });
    const report = await scanChain(rpc, OWNER, 56, { blocks: 1000, ...noPrices });
    assert.equal(report.approvals.length, 1);
    const a = report.approvals[0];
    assert.equal(a.token, TOKEN_A);
    assert.equal(a.tokenSymbol, "TOKA");
    assert.equal(a.decimals, 6);
    assert.equal(a.allowance, MAX_UINT256);
    assert.equal(a.unlimited, true);
    assert.equal(a.spenderIsEOA, true);
    assert.equal(a.ageDays, 200);
    assert.equal(a.discoveredVia, "approval-log");
    // 50 unlimited + 15 EOA + 10 unrecognized + 10 stale = 85 -> CRITICAL
    assert.equal(a.score, 85);
    assert.equal(a.level, "CRITICAL");
    assert.ok(a.revokeCalldata.startsWith("0x095ea7b3"));
    assert.ok(a.revokeExplanation.includes("exactly 0"));
  });

  it("drops pairs whose current allowance is zero (revoked/spent)", async () => {
    const rpc = fakeRpc({
      logs: [
        approvalLog(TOKEN_A, EOA_SPENDER, MAX_UINT256, 50),
        approvalLog(TOKEN_B, ROUTER, 1000n, 90),
      ],
      allowances: {
        [`${TOKEN_A}:${EOA_SPENDER}`]: MAX_UINT256,
        [`${TOKEN_B}:${ROUTER}`]: 0n, // revoked since the log
      },
      balances: { [TOKEN_A]: 100n },
    });
    const report = await scanChain(rpc, OWNER, 56, { blocks: 1000, ...noPrices });
    assert.equal(report.approvals.length, 1);
    assert.equal(report.approvals[0].token, TOKEN_A);
  });

  it("dedupes repeated logs for the same pair and keeps the earliest block", async () => {
    const rpc = fakeRpc({
      logs: [
        approvalLog(TOKEN_A, EOA_SPENDER, 100n, 500),
        approvalLog(TOKEN_A, EOA_SPENDER, MAX_UINT256, 50),
        approvalLog(TOKEN_A, EOA_SPENDER, 200n, 300),
      ],
      allowances: { [`${TOKEN_A}:${EOA_SPENDER}`]: MAX_UINT256 },
      balances: { [TOKEN_A]: 100n },
    });
    const report = await scanChain(rpc, OWNER, 56, { blocks: 1000, ...noPrices });
    assert.equal(report.approvals.length, 1);
    assert.equal(report.approvals[0].earliestBlock, 50);
  });

  it("finds approvals to known spenders via the sweep even with no logs", async () => {
    const usdt = "0x55d398326f99059ff775485246999027b3197955";
    const rpc = fakeRpc({
      logs: [],
      allowances: {},
      balances: {},
    });
    // Extend the fake: USDT metadata + a live allowance to the router.
    const origCall = rpc.call;
    rpc.call = async (method, params = [], opts) => {
      if (method === "eth_call") {
        const { to, data } = params[0];
        if (to.toLowerCase() === usdt) {
          if (data.slice(0, 10) === SELECTORS.decimals) return word(18);
          if (data.slice(0, 10) === SELECTORS.symbol) return abiString("USDT");
          if (data.slice(0, 10) === SELECTORS.allowance) {
            const spender = "0x" + data.slice(98, 138).toLowerCase();
            if (spender === ROUTER) return word(5000000000000000000n);
          }
          if (data.slice(0, 10) === SELECTORS.balanceOf) return word(1000000000000000000n);
        }
      }
      return origCall(method, params, opts);
    };
    const report = await scanChain(rpc, OWNER, 56, { blocks: 1000, ...noPrices });
    const hit = report.approvals.find((a) => a.token === usdt && a.spender === ROUTER);
    assert.ok(hit, "sweep should surface the USDT->router approval");
    assert.equal(hit.discoveredVia, "known-spender-sweep");
    assert.equal(hit.spenderLabel, "PancakeSwap V2 Router");
  });

  it("skips tokens that fail on-chain metadata verification", async () => {
    const rpc = fakeRpc({
      logs: [approvalLog("0xcccccccccccccccccccccccccccccccccccccccc", EOA_SPENDER, MAX_UINT256, 50)],
      allowances: {},
      balances: {},
    });
    const report = await scanChain(rpc, OWNER, 56, { blocks: 1000, ...noPrices });
    assert.equal(report.approvals.length, 0);
  });

  it("propagates RateLimitError from scanChain and marks partial in scanAll", async () => {
    const rpc = fakeRpc({ failWith: new RateLimitError("all endpoints limited") });
    await assert.rejects(() => scanChain(rpc, OWNER, 56, { blocks: 10, ...noPrices }), RateLimitError);
    const merged = await scanAll(() => rpc, OWNER, [56, 1], { blocks: 10, ...noPrices });
    assert.equal(merged.partial, true);
    assert.equal(merged.chains.length, 0);
    assert.ok(merged.warnings.some((w) => w.includes("PARTIAL")));
  });

  it("decodes bytes32 symbols (token B)", async () => {
    const rpc = fakeRpc({
      logs: [approvalLog(TOKEN_B, ROUTER, 1000n, 90)],
      allowances: { [`${TOKEN_B}:${ROUTER}`]: 1000n },
      balances: { [TOKEN_B]: 2000n },
    });
    const report = await scanChain(rpc, OWNER, 56, { blocks: 1000, ...noPrices });
    assert.equal(report.approvals.length, 1);
    assert.equal(report.approvals[0].tokenSymbol, "TOKB");
    assert.equal(report.approvals[0].decimals, 18);
  });
});
