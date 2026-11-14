import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimitError, RpcError, createLimiter, createRpcClient } from "../src/rpc.js";

function jsonResponse(status, json) {
  return { status, ok: status >= 200 && status < 300, text: async () => JSON.stringify(json) };
}

function scriptedFetch(responses) {
  // responses: array of (url, body) => response, consumed in order per URL.
  const queues = new Map();
  for (const [url, list] of Object.entries(responses)) queues.set(url, [...list]);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(url);
    const q = queues.get(url);
    if (!q || q.length === 0) throw new Error(`unexpected fetch to ${url}`);
    const next = q.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetchImpl, calls };
}

const OK = (result) => jsonResponse(200, { jsonrpc: "2.0", id: 1, result });

describe("rpc client", () => {
  it("rotates to the next endpoint on a 429 and returns the good result", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      "https://a.example": [jsonResponse(429, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limit exceeded" } })],
      "https://b.example": [OK("0x38")],
    });
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetchImpl });
    assert.equal(await rpc.call("eth_blockNumber"), "0x38");
    assert.deepEqual(calls, ["https://a.example", "https://b.example"]);
  });

  it("stops with RateLimitError when every endpoint rate-limits", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      "https://a.example": [jsonResponse(429, { jsonrpc: "2.0", id: 1, error: { code: -32005, message: "rate limited" } })],
      "https://b.example": [jsonResponse(429, { jsonrpc: "2.0", id: 1, error: { code: 429, message: "too many requests" } })],
    });
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetchImpl });
    await assert.rejects(() => rpc.call("eth_blockNumber"), RateLimitError);
    assert.equal(calls.length, 2, "each endpoint tried exactly once, no retry loop");
  });

  it("rotates past a non-JSON (HTML) error page", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://a.example": [{ status: 200, ok: true, text: async () => "<html>blocked</html>" }],
      "https://b.example": [OK("0x1")],
    });
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetchImpl });
    assert.equal(await rpc.call("eth_chainId"), "0x1");
  });

  it("rotates past transport failures", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://a.example": [new TypeError("fetch failed")],
      "https://b.example": [OK("0x1")],
    });
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetchImpl });
    assert.equal(await rpc.call("eth_chainId"), "0x1");
  });

  it("fails fast on non-retryable JSON-RPC errors without rotating", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      "https://a.example": [jsonResponse(200, { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "invalid params" } })],
      "https://b.example": [OK("0x1")],
    });
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetchImpl });
    await assert.rejects(() => rpc.call("eth_call", []), (err) => err instanceof RpcError && err.code === -32602);
    assert.deepEqual(calls, ["https://a.example"]);
  });

  it("skips a dead endpoint briefly instead of paying its failure on every call", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      "https://a.example": [new TypeError("fetch failed")],
      "https://b.example": [OK("0x1"), OK("0x2")],
    });
    const rpc = createRpcClient(["https://a.example", "https://b.example"], { fetchImpl, cooldownMs: 60000 });
    assert.equal(await rpc.call("eth_chainId"), "0x1");
    assert.equal(await rpc.call("eth_chainId"), "0x2");
    // Second call goes straight to the healthy endpoint: the dead one is cooling down.
    assert.deepEqual(calls, ["https://a.example", "https://b.example", "https://b.example"]);
  });

  it("verifies the endpoint chain id and rejects a wrong-chain endpoint", async () => {
    const { fetchImpl } = scriptedFetch({
      "https://a.example": [
        OK("0x1000"),
        jsonResponse(200, { jsonrpc: "2.0", id: 2, result: "0x1" }), // eth_chainId says 1
      ],
    });
    const rpc = createRpcClient(["https://a.example"], { fetchImpl });
    await assert.rejects(
      () => rpc.call("eth_blockNumber", [], { expectedChainId: 56 }),
      /serves chain 1, expected 56/,
    );
  });

  it("accepts a matching chain id and caches the check", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      "https://a.example": [OK("0x1000"), OK("0x38"), OK("0x1001")],
    });
    const rpc = createRpcClient(["https://a.example"], { fetchImpl });
    assert.equal(await rpc.call("eth_blockNumber", [], { expectedChainId: 56 }), "0x1000");
    assert.equal(await rpc.call("eth_blockNumber", [], { expectedChainId: 56 }), "0x1001");
    assert.equal(calls.length, 3, "chain id checked once, then cached");
  });
});

describe("concurrency limiter", () => {
  it("never exceeds the max in flight", async () => {
    const limit = createLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const jobs = Array.from({ length: 6 }, () =>
      limit(async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return true;
      }),
    );
    await Promise.all(jobs);
    assert.equal(peak, 2);
  });
});
