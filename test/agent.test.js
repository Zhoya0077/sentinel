import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { diffReports, recommend } from "../src/agent.js";

function approval(overrides) {
  return {
    chainId: 56,
    token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    tokenSymbol: "TOKA",
    spender: "0x2222222222222222222222222222222222222222",
    allowance: 100n,
    level: "LOW",
    score: 0,
    ...overrides,
  };
}

function report(approvals) {
  return {
    owner: "0x1111111111111111111111111111111111111111",
    scannedAt: "2026-11-15T00:00:00.000Z",
    chains: [{ chainId: 56, approvals }],
    warnings: [],
    partial: false,
  };
}

describe("agent loop", () => {
  it("recommends revoke-now for CRITICAL/HIGH, review-soon for MEDIUM, ok for LOW", () => {
    assert.equal(recommend(approval({ level: "CRITICAL" })), "revoke-now");
    assert.equal(recommend(approval({ level: "HIGH" })), "revoke-now");
    assert.equal(recommend(approval({ level: "MEDIUM" })), "review-soon");
    assert.equal(recommend(approval({ level: "LOW" })), "ok");
  });

  it("diff detects added, removed, and changed approvals", () => {
    const before = report([
      approval({ spender: "0x2222222222222222222222222222222222222222", allowance: 100n, score: 0, level: "LOW" }),
      approval({ spender: "0x3333333333333333333333333333333333333333", allowance: 50n, score: 10, level: "LOW" }),
    ]);
    const after = report([
      approval({ spender: "0x2222222222222222222222222222222222222222", allowance: 200n, score: 20, level: "MEDIUM" }),
      approval({ spender: "0x4444444444444444444444444444444444444444", allowance: 1n, score: 0, level: "LOW" }),
    ]);
    const diff = diffReports(before, after);
    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].spender, "0x4444444444444444444444444444444444444444");
    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0].spender, "0x3333333333333333333333333333333333333333");
    assert.equal(diff.changed.length, 1);
    assert.equal(diff.changed[0].before.allowance, 100n);
    assert.equal(diff.changed[0].after.allowance, 200n);
  });

  it("diff is empty for identical reports", () => {
    const a = report([approval({})]);
    const b = report([approval({})]);
    const diff = diffReports(a, b);
    assert.deepEqual(diff, { added: [], removed: [], changed: [] });
  });
});
