// The agentic loop: scan -> score -> recommend -> generate revoke calldata,
// then watch mode re-scans on an interval and reports only what CHANGED.
//
// A "cycle" is one full scan + scoring + recommendation pass. The watch loop
// diffs consecutive cycles by (chain, token, spender): new approvals,
// removed approvals (revoked or spent), and changed allowances. Nothing here
// ever signs or broadcasts — recommendations are calldata the user reviews.

import { scanAll } from "./scanner.js";

export const RECOMMENDATION = {
  REVOKE_NOW: "revoke-now",
  REVIEW_SOON: "review-soon",
  OK: "ok",
};

export function recommend(approval) {
  if (approval.level === "CRITICAL" || approval.level === "HIGH") return RECOMMENDATION.REVOKE_NOW;
  if (approval.level === "MEDIUM") return RECOMMENDATION.REVIEW_SOON;
  return RECOMMENDATION.OK;
}

export async function runCycle(rpcForChain, owner, chainIds, options = {}) {
  const report = await scanAll(rpcForChain, owner, chainIds, options);
  const recommendations = [];
  for (const chainReport of report.chains) {
    for (const approval of chainReport.approvals) {
      recommendations.push({
        chainId: chainReport.chainId,
        token: approval.token,
        tokenSymbol: approval.tokenSymbol,
        spender: approval.spender,
        level: approval.level,
        score: approval.score,
        action: recommend(approval),
        revokeCalldata: approval.revokeCalldata,
        revokeExplanation: approval.revokeExplanation,
      });
    }
  }
  recommendations.sort((a, b) => b.score - a.score);
  return { report, recommendations };
}

function approvalKey(a) {
  return `${a.chainId}:${a.token}:${a.spender}`;
}

function flatten(report) {
  const map = new Map();
  for (const chainReport of report.chains) {
    for (const a of chainReport.approvals) map.set(approvalKey({ ...a, chainId: chainReport.chainId }), a);
  }
  return map;
}

/**
 * Diff two reports. Returns added / removed / changed approvals.
 * `changed` covers allowance or risk-level changes on the same pair.
 */
export function diffReports(previous, current) {
  const prev = flatten(previous);
  const curr = flatten(current);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [key, a] of curr) {
    const p = prev.get(key);
    if (!p) added.push(a);
    else if (p.allowance !== a.allowance || p.level !== a.level || p.score !== a.score) {
      changed.push({ before: p, after: a });
    }
  }
  for (const [key, a] of prev) {
    if (!curr.has(key)) removed.push(a);
  }
  return { added, removed, changed };
}

/**
 * Watch loop: run cycles forever (or until `signal` aborts), calling
 * `onCycle` after each cycle with { cycle, report, recommendations, diff }.
 * `diff` is null for the first cycle. The loop never overlaps cycles: the
 * interval is measured from the END of one cycle to the START of the next,
 * so a slow scan cannot pile up requests.
 */
export async function watch(rpcForChain, owner, chainIds, { intervalMs = 300000, onCycle, signal, scanOptions = {} } = {}) {
  let previous = null;
  let cycle = 0;
  while (!signal?.aborted) {
    cycle++;
    const { report, recommendations } = await runCycle(rpcForChain, owner, chainIds, scanOptions);
    const diff = previous ? diffReports(previous, report) : null;
    previous = report;
    if (onCycle) await onCycle({ cycle, report, recommendations, diff });
    if (signal?.aborted) break;
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
}
