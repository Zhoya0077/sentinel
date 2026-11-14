import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalReportString,
  canonicalize,
  countByLevel,
  renderMarkdownReport,
  renderTextReport,
  reportToJson,
} from "../src/report.js";
import { MAX_UINT256 } from "../src/codec.js";

function sampleReport() {
  return {
    owner: "0x1111111111111111111111111111111111111111",
    scannedAt: "2026-11-15T00:00:00.000Z",
    chains: [
      {
        chainId: 56,
        chainName: "BNB Chain",
        scannedFromBlock: 0,
        scannedToBlock: 1000,
        scannedAt: "2026-11-15T00:00:00.000Z",
        pairsConsidered: 3,
        approvals: [
          {
            chainId: 56,
            token: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            tokenSymbol: "TOKA",
            tokenName: null,
            decimals: 6,
            spender: "0x2222222222222222222222222222222222222222",
            spenderLabel: null,
            spenderIsEOA: true,
            allowance: MAX_UINT256,
            balance: 2500000n,
            unlimited: true,
            ageDays: 200,
            earliestBlock: 50,
            earliestTx: "0x" + "cd".repeat(32),
            discoveredVia: "approval-log",
            priceUsdCents: null,
            exposureUsdCents: null,
            score: 85,
            level: "CRITICAL",
            reasons: ["Unlimited allowance"],
            revokeCalldata: "0x095ea7b3" + "0".repeat(128),
            revokeExplanation: "Sets allowance to 0.",
          },
        ],
        warnings: [],
        partial: false,
      },
    ],
    warnings: [],
    partial: false,
  };
}

describe("report", () => {
  it("canonicalize renders BigInt as decimal strings and sorts keys", () => {
    const out = canonicalize({ b: 1n, a: { z: 2n, y: [3n] } });
    assert.deepEqual(out, { a: { y: ["3"], z: "2" }, b: "1" });
    assert.equal(JSON.stringify(out), '{"a":{"y":["3"],"z":"2"},"b":"1"}');
  });

  it("canonicalReportString is stable across key order and excludes timestamps", () => {
    const r1 = sampleReport();
    const r2 = sampleReport();
    r2.scannedAt = "2026-11-16T00:00:00.000Z";
    r2.warnings = ["a warning"];
    assert.equal(canonicalReportString(r1), canonicalReportString(r2));
  });

  it("reportToJson never throws on BigInt values", () => {
    const json = reportToJson(sampleReport());
    const parsed = JSON.parse(json);
    assert.equal(parsed.chains[0].approvals[0].allowance, MAX_UINT256.toString(10));
  });

  it("counts levels", () => {
    const counts = countByLevel([{ level: "CRITICAL" }, { level: "CRITICAL" }, { level: "LOW" }]);
    assert.deepEqual(counts, { CRITICAL: 2, HIGH: 0, MEDIUM: 0, LOW: 1 });
  });

  it("text report shows UNLIMITED, the score, and the revoke calldata", () => {
    const text = renderTextReport(sampleReport());
    assert.ok(text.includes("UNLIMITED"));
    assert.ok(text.includes("[CRITICAL 85]"));
    assert.ok(text.includes("0x095ea7b3"));
    assert.ok(text.includes("never signs"));
    assert.ok(text.includes("2.5 TOKA")); // balance formatted with decimals
  });

  it("markdown report renders a table and a revoke section", () => {
    const md = renderMarkdownReport(sampleReport());
    assert.ok(md.includes("| CRITICAL 85 | TOKA |"));
    assert.ok(md.includes("### Revoke calldata"));
    assert.ok(md.includes("0x095ea7b3"));
  });

  it("marks partial reports in both renderers", () => {
    const r = sampleReport();
    r.partial = true;
    assert.ok(renderTextReport(r).includes("PARTIAL"));
    assert.ok(renderMarkdownReport(r).includes("PARTIAL"));
  });
});
