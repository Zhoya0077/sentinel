// Revoke helper: generate the EXACT approve(spender, 0) calldata that
// revokes an allowance, plus a human-readable decode of what it does.
//
// Sentinel NEVER signs, NEVER broadcasts, and NEVER connects a wallet. The
// user reviews the calldata and the decode, then signs in their own wallet.
// Every generated calldata is round-tripped (decode -> re-encode -> compare)
// before it is emitted, so a malformed payload can never leave this module.

import { SELECTORS, decodeUint256, encodeApproveCall, normalizeAddress, padAddress, padUint256 } from "./codec.js";

/** Build approve(spender, 0) calldata. Throws on a bad spender address. */
export function buildRevokeCalldata(spender) {
  const data = encodeApproveCall(normalizeAddress(spender), 0n);
  // Round-trip check: decode it back and require an exact match.
  const decoded = decodeApproveCalldata(data);
  if (!decoded || decoded.spender !== normalizeAddress(spender) || decoded.amount !== 0n) {
    throw new Error("revoke calldata failed its round-trip check — refusing to emit");
  }
  return data;
}

/** Decode approve(spender, amount) calldata. Returns null when malformed. */
export function decodeApproveCalldata(calldata) {
  if (typeof calldata !== "string" || !calldata.startsWith("0x")) return null;
  const body = calldata.slice(2);
  if (body.length !== 8 + 64 + 64) return null;
  if ("0x" + body.slice(0, 8) !== SELECTORS.approve) return null;
  const spenderWord = body.slice(8, 72);
  const amountWord = body.slice(72, 136);
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(spenderWord)) return null;
  const spender = "0x" + spenderWord.slice(24).toLowerCase();
  const amount = decodeUint256("0x" + amountWord);
  if (amount == null) return null;
  return { selector: SELECTORS.approve, spender, amount };
}

/** True only for an exact approve(spender, 0) revoke payload. */
export function isRevokeCalldata(calldata, expectedSpender = null) {
  const decoded = decodeApproveCalldata(calldata);
  if (!decoded || decoded.amount !== 0n) return false;
  if (expectedSpender != null && decoded.spender !== normalizeAddress(expectedSpender)) return false;
  return true;
}

/**
 * Human-readable explanation of a revoke transaction. States precisely what
 * the transaction does and does not do, and the checks to run before signing.
 */
export function explainRevoke({ token, tokenSymbol, spender, spenderLabel }) {
  const symbol = tokenSymbol ?? "token";
  const who = spenderLabel ? `${spender} (${spenderLabel})` : spender;
  return [
    `This transaction calls approve(${spender}, 0) on the ${symbol} contract (${token}).`,
    `Effect: it sets the allowance of ${who} to exactly 0. That spender will no longer be able to move your ${symbol}.`,
    `It does NOT move any tokens, and it does NOT change any other approval.`,
    `Before signing, verify in your wallet: (1) the "to" address is the ${symbol} contract ${token}; (2) the spender in the data is ${spender}; (3) the amount is exactly 0; (4) you are on the expected network.`,
  ].join(" ");
}

/** Re-encode check used by tests and the CLI: decode then re-encode must equal input. */
export function roundTrip(calldata) {
  const decoded = decodeApproveCalldata(calldata);
  if (!decoded) return false;
  return encodeApproveCall(decoded.spender, decoded.amount).toLowerCase() === calldata.toLowerCase();
}

export { padAddress, padUint256 };
