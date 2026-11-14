import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_UINT256 } from "../src/codec.js";
import { exposureUsdCents, formatUsdCents, riskLevel, scoreApproval } from "../src/risk.js";

const base = {
  allowance: 100n,
  balance: 1000n,
  decimals: 6,
  spenderIsEOA: false,
  knownSpender: { label: "Known Router" },
  ageDays: 1,
  exposureUsdCents: null,
};

describe("risk scoring", () => {
  it("scores a small exact approval to a known contract as LOW", () => {
    const r = scoreApproval(base);
    assert.equal(r.score, 0);
    assert.equal(r.level, "LOW");
    assert.equal(r.unlimited, false);
  });

  it("scores unlimited + EOA + unrecognized + stale + big exposure as CRITICAL", () => {
    const r = scoreApproval({
      ...base,
      allowance: MAX_UINT256,
      balance: 5000000000n,
      spenderIsEOA: true,
      knownSpender: null,
      ageDays: 200,
      exposureUsdCents: 200000,
    });
    // 50 + 15 + 10 + 10 + 10 = 95
    assert.equal(r.score, 95);
    assert.equal(r.level, "CRITICAL");
    assert.equal(r.unlimited, true);
    assert.ok(r.reasons.some((x) => x.includes("Unlimited")));
  });

  it("scores unlimited to a KNOWN protocol as HIGH, not zero", () => {
    const r = scoreApproval({ ...base, allowance: MAX_UINT256 });
    assert.equal(r.score, 50);
    assert.equal(r.level, "HIGH");
  });

  it("adds full-balance coverage only for non-unlimited approvals", () => {
    const r = scoreApproval({ ...base, allowance: 1000n, balance: 1000n });
    assert.equal(r.score, 20);
    assert.equal(r.level, "MEDIUM");
  });

  it("adds unrecognized-spender points and labels them honestly", () => {
    const r = scoreApproval({ ...base, knownSpender: null });
    assert.equal(r.score, 10);
    assert.ok(r.reasons.some((x) => x.includes("not on the verified known-protocol list")));
  });

  it("applies age bands", () => {
    assert.equal(scoreApproval({ ...base, ageDays: 29 }).score, 0);
    assert.equal(scoreApproval({ ...base, ageDays: 30 }).score, 5);
    assert.equal(scoreApproval({ ...base, ageDays: 179 }).score, 5);
    assert.equal(scoreApproval({ ...base, ageDays: 180 }).score, 10);
    assert.equal(scoreApproval({ ...base, ageDays: null }).score, 0);
  });

  it("applies exposure bands", () => {
    assert.equal(scoreApproval({ ...base, exposureUsdCents: 10000 }).score, 0);
    assert.equal(scoreApproval({ ...base, exposureUsdCents: 10001 }).score, 5);
    assert.equal(scoreApproval({ ...base, exposureUsdCents: 100001 }).score, 10);
  });

  it("maps scores to levels at the documented thresholds", () => {
    assert.equal(riskLevel(0), "LOW");
    assert.equal(riskLevel(19), "LOW");
    assert.equal(riskLevel(20), "MEDIUM");
    assert.equal(riskLevel(39), "MEDIUM");
    assert.equal(riskLevel(40), "HIGH");
    assert.equal(riskLevel(69), "HIGH");
    assert.equal(riskLevel(70), "CRITICAL");
  });

  it("computes exposure as min(allowance, balance) x price in integer cents", () => {
    // balance 2.5 tokens at $1.00, allowance unlimited -> exposure $2.50 = 250 cents
    assert.equal(exposureUsdCents(MAX_UINT256, 2500000n, 6, 100n), 250n);
    // allowance 1 token, balance 5 tokens, price $2.00 -> $2.00 = 200 cents
    assert.equal(exposureUsdCents(1000000n, 5000000n, 6, 200n), 200n);
    assert.equal(exposureUsdCents(0n, 5000000n, 6, 200n), 0n);
    assert.equal(exposureUsdCents(100n, 100n, 6, null), null);
  });

  it("formats USD cents without floats", () => {
    assert.equal(formatUsdCents(250n), "$2.50");
    assert.equal(formatUsdCents(100n), "$1.00");
    assert.equal(formatUsdCents(5n), "$0.05");
    assert.equal(formatUsdCents(null), null);
  });
});
