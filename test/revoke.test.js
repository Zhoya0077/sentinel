import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildRevokeCalldata,
  decodeApproveCalldata,
  explainRevoke,
  isRevokeCalldata,
  roundTrip,
} from "../src/revoke.js";

const SPENDER = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const EXPECTED =
  "0x095ea7b3" +
  "00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e" +
  "0000000000000000000000000000000000000000000000000000000000000000";

describe("revoke helper", () => {
  it("builds the exact approve(spender, 0) calldata", () => {
    assert.equal(buildRevokeCalldata(SPENDER), EXPECTED);
  });

  it("decodes its own calldata back to spender + 0", () => {
    const decoded = decodeApproveCalldata(EXPECTED);
    assert.equal(decoded.spender, SPENDER.toLowerCase());
    assert.equal(decoded.amount, 0n);
    assert.equal(decoded.selector, "0x095ea7b3");
  });

  it("round-trips decode -> re-encode exactly", () => {
    assert.equal(roundTrip(EXPECTED), true);
  });

  it("rejects malformed calldata", () => {
    assert.equal(decodeApproveCalldata("0x095ea7b3"), null);
    assert.equal(decodeApproveCalldata("0xdeadbeef" + "0".repeat(128)), null);
    assert.equal(decodeApproveCalldata("not hex"), null);
    // A well-formed approve with amount 1 decodes fine — it is just not a revoke.
    assert.equal(decodeApproveCalldata(EXPECTED.slice(0, -2) + "01").amount, 1n);
  });

  it("distinguishes revoke (amount 0) from other approvals", () => {
    const approveOne =
      "0x095ea7b3" +
      "00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e" +
      "0000000000000000000000000000000000000000000000000000000000000001";
    assert.equal(isRevokeCalldata(EXPECTED, SPENDER), true);
    assert.equal(isRevokeCalldata(approveOne, SPENDER), false);
    assert.equal(isRevokeCalldata(EXPECTED, "0x2222222222222222222222222222222222222222"), false);
  });

  it("rejects bad spender addresses", () => {
    assert.throws(() => buildRevokeCalldata("0x123"), /invalid EVM address/);
  });

  it("explains the effect and the pre-signing checks in plain language", () => {
    const text = explainRevoke({
      token: "0x55d398326f99059ff775485246999027b3197955",
      tokenSymbol: "USDT",
      spender: SPENDER.toLowerCase(),
      spenderLabel: "PancakeSwap V2 Router",
    });
    assert.ok(text.includes("approve("));
    assert.ok(text.includes("sets the allowance"));
    assert.ok(text.includes("exactly 0"));
    assert.ok(text.includes("does NOT move any tokens"));
    assert.ok(text.includes("Before signing, verify"));
  });
});
