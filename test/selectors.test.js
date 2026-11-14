import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { APPROVAL_TOPIC, SELECTORS } from "../src/codec.js";

// Independent cross-check of every hand-written selector constant against
// ethers' Interface. This test is OPTIONAL: it skips gracefully when ethers
// is not installed (the core has zero dependencies). When ethers IS present
// (dev machines), a wrong constant fails loudly here instead of silently
// producing bad calldata in production.

describe("selector cross-check (ethers, optional)", async () => {
  let ethers = null;
  try {
    ethers = await import("ethers");
  } catch {
    // ethers not installed — skip.
  }

  const cases = [
    ["allowance(address,address)", SELECTORS.allowance],
    ["approve(address,uint256)", SELECTORS.approve],
    ["balanceOf(address)", SELECTORS.balanceOf],
    ["decimals()", SELECTORS.decimals],
    ["symbol()", SELECTORS.symbol],
    ["name()", SELECTORS.name],
    ["factory()", SELECTORS.factory],
    ["WETH()", SELECTORS.weth],
  ];

  for (const [signature, expected] of cases) {
    it(`${signature} -> ${expected}`, { skip: !ethers }, () => {
      const iface = new ethers.Interface([`function ${signature}`]);
      assert.equal(iface.getFunction(signature).selector, expected);
    });
  }

  it("Approval event topic", { skip: !ethers }, () => {
    const iface = new ethers.Interface(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
    assert.equal(iface.getEvent("Approval").topicHash, APPROVAL_TOPIC);
  });

  it("approve calldata encoding matches ethers", { skip: !ethers }, async () => {
    const { encodeApproveCall } = await import("../src/codec.js");
    const iface = new ethers.Interface(["function approve(address spender, uint256 amount)"]);
    const spender = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
    assert.equal(
      encodeApproveCall(spender, 0n).toLowerCase(),
      iface.encodeFunctionData("approve", [spender, 0n]).toLowerCase(),
    );
  });
});
