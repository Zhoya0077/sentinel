import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_TOPIC } from "../src/codec.js";
import { RateLimitError, RpcError } from "../src/rpc.js";
import { scanApprovalLogs } from "../src/logs.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SPENDER = "0x2222222222222222222222222222222222222222";

function approvalLog(blockNumber) {
  return {
    address: TOKEN_A,
    topics: [
      APPROVAL_TOPIC,
      "0x" + "0".repeat(24) + OWNER.slice(2),
      "0x" + "0".repeat(24) + SPENDER.slice(2),
    ],
    data: "0x" + "0".repeat(63) + "1",
    blockNumber: "0x" + blockNumber.toString(16),
    transactionHash: "0x" + "ab".repeat(32),
    logIndex: "0x0",
  };
}

describe("log scan", () => {
  it("falls back to per-token address filters when the node requires an address", async () => {
    const calls = [];
    const rpc = {
      async call(method, params) {
        calls.push(params[0]);
        if (!params[0].address) {
          throw new RpcError("node: Please specify an address in your request", { code: -32701 });
        }
        return [approvalLog(50)];
      },
    };
    const { logs, warnings } = await scanApprovalLogs(rpc, {
      owner: OWNER,
      fromBlock: 0,
      toBlock: 100,
      curatedAddresses: [TOKEN_A],
    });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].token, TOKEN_A);
    assert.ok(warnings.some((w) => w.includes("address filter")));
    assert.ok(calls.some((f) => f.address === TOKEN_A), "fallback query carries the address filter");
  });

  it("never falls back on rate limits — RateLimitError propagates", async () => {
    const rpc = {
      async call() {
        throw new RateLimitError("limited");
      },
    };
    await assert.rejects(
      () => scanApprovalLogs(rpc, { owner: OWNER, fromBlock: 0, toBlock: 100, curatedAddresses: [TOKEN_A] }),
      RateLimitError,
    );
  });

  it("halves chunks on range errors and still completes", async () => {
    const rpc = {
      async call(method, params) {
        const from = parseInt(params[0].fromBlock, 16);
        const to = parseInt(params[0].toBlock, 16);
        if (to - from + 1 > 100) throw new RpcError("block range too large", { code: -32000 });
        return from <= 50 && to >= 50 ? [approvalLog(50)] : [];
      },
    };
    const { logs, warnings } = await scanApprovalLogs(rpc, {
      owner: OWNER,
      fromBlock: 0,
      toBlock: 1000,
      chunkSize: 1000,
      minChunkSize: 100,
    });
    assert.equal(logs.length, 1);
    assert.ok(warnings.some((w) => w.includes("retrying with")));
  });

  it("skips a range the node rejects even at the minimum chunk size, with a warning", async () => {
    const rpc = {
      async call() {
        throw new RpcError("range exceeds limit", { code: -32000 });
      },
    };
    const { logs, warnings } = await scanApprovalLogs(rpc, {
      owner: OWNER,
      fromBlock: 0,
      toBlock: 100,
      chunkSize: 100,
      minChunkSize: 100,
    });
    assert.equal(logs.length, 0);
    assert.ok(warnings.some((w) => w.includes("skipped log range")));
  });
});
