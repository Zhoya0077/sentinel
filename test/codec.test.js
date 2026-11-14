import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_TOPIC,
  MAX_UINT256,
  SELECTORS,
  decodeAddress,
  decodeApprovalLog,
  decodeString,
  decodeUint256,
  encodeAllowanceCall,
  encodeApproveCall,
  encodeBalanceOfCall,
  formatAmount,
  normalizeAddress,
  padAddress,
  padUint256,
  parseAmount,
} from "../src/codec.js";

describe("codec", () => {
  it("encodes allowance() with the documented selector and layout", () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const spender = "0x2222222222222222222222222222222222222222";
    const data = encodeAllowanceCall(owner, spender);
    assert.equal(
      data,
      "0xdd62ed3e" +
        "0000000000000000000000001111111111111111111111111111111111111111" +
        "0000000000000000000000002222222222222222222222222222222222222222",
    );
  });

  it("encodes approve(spender, 0) revoke calldata exactly", () => {
    const spender = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
    assert.equal(
      encodeApproveCall(spender, 0n),
      "0x095ea7b3" +
        "00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e" +
        "0000000000000000000000000000000000000000000000000000000000000000",
    );
  });

  it("encodes approve(spender, type(uint256).max)", () => {
    const data = encodeApproveCall("0x2222222222222222222222222222222222222222", MAX_UINT256);
    assert.ok(data.endsWith("f".repeat(64)));
  });

  it("encodes balanceOf()", () => {
    assert.equal(
      encodeBalanceOfCall("0x1111111111111111111111111111111111111111"),
      "0x70a08231" + "0000000000000000000000001111111111111111111111111111111111111111",
    );
  });

  it("rejects bad addresses and out-of-range uints", () => {
    assert.throws(() => normalizeAddress("0x1234"), /invalid EVM address/);
    assert.throws(() => padAddress("not-an-address"), /invalid EVM address/);
    assert.throws(() => padUint256(-1n), /out of range/);
    assert.throws(() => padUint256(MAX_UINT256 + 1n), /out of range/);
  });

  it("decodes uint256 returns and empty returns", () => {
    assert.equal(decodeUint256("0x" + "0".repeat(63) + "6"), 6n);
    assert.equal(decodeUint256("0x" + "f".repeat(64)), MAX_UINT256);
    assert.equal(decodeUint256("0x"), null);
    assert.equal(decodeUint256(""), null);
  });

  it("decodes address returns", () => {
    assert.equal(
      decodeAddress("0x" + "0".repeat(24) + "10ed43c718714eb63d5aa57b78b54704e256024e"),
      "0x10ed43c718714eb63d5aa57b78b54704e256024e",
    );
  });

  it("decodes standard ABI strings", () => {
    // symbol() -> "USDT": offset 0x20, length 4, "USDT" padded.
    const hex =
      "0x" +
      "0000000000000000000000000000000000000000000000000000000000000020" +
      "0000000000000000000000000000000000000000000000000000000000000004" +
      "5553445400000000000000000000000000000000000000000000000000000000";
    assert.equal(decodeString(hex), "USDT");
  });

  it("decodes legacy bytes32 symbols", () => {
    const hex = "0x" + Buffer.from("TOKB").toString("hex").padEnd(64, "0");
    assert.equal(decodeString(hex), "TOKB");
  });

  it("returns null for unparseable string data", () => {
    assert.equal(decodeString("0x"), null);
    assert.equal(decodeString("0x" + "ff".repeat(32)), null);
  });

  it("formats amounts with BigInt-only math (no floats)", () => {
    assert.equal(formatAmount(1500000n, 6), "1.5");
    assert.equal(formatAmount(1000000n, 6), "1");
    assert.equal(formatAmount(1n, 18), "0.000000000000000001");
    assert.equal(formatAmount(0n, 6), "0");
    assert.equal(formatAmount(123456789012345678901234567890n, 18), "123456789012.34567890123456789");
  });

  it("parses amounts and round-trips with formatAmount", () => {
    assert.equal(parseAmount("1.5", 6), 1500000n);
    assert.equal(parseAmount("0.000000000000000001", 18), 1n);
    assert.equal(formatAmount(parseAmount("123.456", 6), 6), "123.456");
    assert.throws(() => parseAmount("1.1234567", 6), /too many decimals/);
  });

  it("decodes Approval logs and rejects other topics", () => {
    const owner = "0x1111111111111111111111111111111111111111";
    const spender = "0x2222222222222222222222222222222222222222";
    const log = {
      address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      topics: [
        APPROVAL_TOPIC,
        "0x" + "0".repeat(24) + owner.slice(2),
        "0x" + "0".repeat(24) + spender.slice(2),
      ],
      data: "0x" + "f".repeat(64),
      blockNumber: "0x64",
      transactionHash: "0x" + "ab".repeat(32),
      logIndex: "0x2",
    };
    const decoded = decodeApprovalLog(log);
    assert.equal(decoded.token, "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    assert.equal(decoded.owner, owner);
    assert.equal(decoded.spender, spender);
    assert.equal(decoded.value, MAX_UINT256);
    assert.equal(decoded.blockNumber, 100);
    assert.equal(decodeApprovalLog({ ...log, topics: [SELECTORS.approve, log.topics[1], log.topics[2]] }), null);
    assert.equal(decodeApprovalLog({ ...log, topics: log.topics.slice(0, 2) }), null);
  });
});
