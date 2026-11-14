// Transparent risk scoring. Every point comes from an on-chain fact (or an
// explicitly-labelled price estimate). The formula is documented in full in
// README.md so a reviewer can audit it; there are no hidden weights and no
// invented reputation data.
//
// Components:
//   unlimited allowance (== type(uint256).max) ............ +50
//   allowance covers the full current balance ............ +20
//   spender is an EOA (no contract code) ................. +15
//   spender unrecognized (not on the verified list) ...... +10
//   approval older than 180 days ......................... +10 (30-179d: +5)
//   exposure over $1,000 ................................. +10 (over $100: +5)
//
// Levels: 70+ CRITICAL, 40+ HIGH, 20+ MEDIUM, else LOW.
// A recognized spender earns no "unrecognized" points but an unlimited
// approval to a known protocol is still HIGH: unlimited is unlimited.

import { MAX_UINT256, formatAmount } from "./codec.js";

export const RISK_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];

export function riskLevel(score) {
  if (score >= 70) return "CRITICAL";
  if (score >= 40) return "HIGH";
  if (score >= 20) return "MEDIUM";
  return "LOW";
}

/**
 * @param {object} input
 * @param {bigint} input.allowance - current on-chain allowance (raw units)
 * @param {bigint} input.balance - owner's current token balance (raw units)
 * @param {number} input.decimals
 * @param {boolean} input.spenderIsEOA
 * @param {object|null} input.knownSpender - verified-list entry or null
 * @param {number|null} input.ageDays - age of the earliest observed approval, or null if unknown
 * @param {number|null} input.exposureUsdCents - min(allowance, balance) in USD cents (BigInt math), or null
 */
export function scoreApproval(input) {
  const { allowance, balance } = input;
  let score = 0;
  const reasons = [];

  const unlimited = allowance === MAX_UINT256;
  if (unlimited) {
    score += 50;
    reasons.push("Unlimited allowance (type(uint256).max) — the spender can move any future balance too");
  }
  if (balance > 0n && allowance >= balance && !unlimited) {
    score += 20;
    reasons.push("Allowance covers the full current balance");
  }
  if (input.spenderIsEOA) {
    score += 15;
    reasons.push("Spender is an externally-owned account (no contract code)");
  }
  if (input.knownSpender) {
    reasons.push(`Spender is a recognized protocol contract (${input.knownSpender.label})`);
  } else {
    score += 10;
    reasons.push("Spender is not on the verified known-protocol list — verify before trusting");
  }
  if (input.ageDays != null) {
    if (input.ageDays >= 180) {
      score += 10;
      reasons.push(`Approval is ${Math.floor(input.ageDays)} days old (stale)`);
    } else if (input.ageDays >= 30) {
      score += 5;
      reasons.push(`Approval is ${Math.floor(input.ageDays)} days old`);
    }
  }
  if (input.exposureUsdCents != null) {
    if (input.exposureUsdCents > 100000) {
      score += 10;
      reasons.push("Current exposure over $1,000 (approximate USD)");
    } else if (input.exposureUsdCents > 10000) {
      score += 5;
      reasons.push("Current exposure over $100 (approximate USD)");
    }
  }

  return { score, level: riskLevel(score), reasons, unlimited };
}

/**
 * Exposure in USD cents with BigInt-only math: the spender can take at most
 * min(allowance, balance) of what is there now. priceUsdCents is the token
 * price in integer cents (e.g. $1.00 -> 100n). Returns null without a price.
 */
export function exposureUsdCents(allowance, balance, decimals, priceUsdCents) {
  if (priceUsdCents == null) return null;
  const exposed = allowance < balance ? allowance : balance;
  if (exposed <= 0n) return 0n;
  const cents = (exposed * BigInt(priceUsdCents)) / 10n ** BigInt(decimals);
  return cents > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : cents;
}

export function formatUsdCents(cents) {
  if (cents == null) return null;
  const c = BigInt(cents);
  const dollars = c / 100n;
  const rem = (c % 100n).toString().padStart(2, "0");
  return `$${dollars.toString()}.${rem}`;
}

export { formatAmount };
