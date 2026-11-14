// Minimal ABI codec for the handful of ERC-20 calls Sentinel needs.
// Zero dependencies, BigInt-only arithmetic. The same code runs in Node and
// in the browser demo. Selectors are the first 4 bytes of
// keccak256("<signature>"); see test/selectors.test.js for an independent
// cross-check against ethers.

export const MAX_UINT256 = (2n ** 256n) - 1n;

export const SELECTORS = {
  allowance: "0xdd62ed3e", // allowance(address,address)
  approve: "0x095ea7b3", // approve(address,uint256)
  balanceOf: "0x70a08231", // balanceOf(address)
  decimals: "0x313ce567", // decimals()
  symbol: "0x95d89b41", // symbol()
  name: "0x06fdde03", // name()
  factory: "0xc45a0155", // factory()
  weth: "0xad5c4648", // WETH()
};

// keccak256("Approval(address,address,uint256)")
export const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Validate an address string. Returns the lowercase form. Throws on bad input. */
export function normalizeAddress(address) {
  if (typeof address !== "string" || !ADDRESS_RE.test(address)) {
    throw new Error(`invalid EVM address: ${String(address).slice(0, 42)}`);
  }
  return address.toLowerCase();
}

export function isAddress(value) {
  return typeof value === "string" && ADDRESS_RE.test(value);
}

function strip0x(hex) {
  if (typeof hex !== "string" || !hex.startsWith("0x")) {
    throw new Error(`expected 0x-prefixed hex, got: ${String(hex).slice(0, 20)}`);
  }
  return hex.slice(2);
}

export function padAddress(address) {
  return normalizeAddress(address).slice(2).padStart(64, "0");
}

export function padUint256(value) {
  const v = BigInt(value);
  if (v < 0n || v > MAX_UINT256) throw new Error(`uint256 out of range: ${v}`);
  return v.toString(16).padStart(64, "0");
}

export function encodeCall(selector, words = []) {
  return selector + words.join("");
}

export function encodeAllowanceCall(owner, spender) {
  return encodeCall(SELECTORS.allowance, [padAddress(owner), padAddress(spender)]);
}

export function encodeApproveCall(spender, amount) {
  return encodeCall(SELECTORS.approve, [padAddress(spender), padUint256(amount)]);
}

export function encodeBalanceOfCall(owner) {
  return encodeCall(SELECTORS.balanceOf, [padAddress(owner)]);
}

/** Decode a uint256 eth_call return. Returns null when the call returned no data
 *  (the target is not a contract, or has no such function). */
export function decodeUint256(hex) {
  if (hex === "0x" || hex === "" || hex == null) return null;
  const body = strip0x(hex);
  if (body.length === 0) return null;
  if (body.length > 64) throw new Error(`uint256 return too long: ${body.length} hex chars`);
  return BigInt("0x" + body);
}

/** Decode an eth_call address return (right-aligned in a 32-byte word). */
export function decodeAddress(hex) {
  const body = strip0x(hex);
  if (body.length < 40) return null;
  return "0x" + body.slice(-40).toLowerCase();
}

/**
 * Decode a string return from symbol()/name(). Handles both the standard
 * ABI-encoded string and the legacy bytes32 form some old tokens use.
 * Returns null when the data cannot be interpreted as text.
 */
export function decodeString(hex) {
  if (hex === "0x" || hex === "" || hex == null) return null;
  const body = strip0x(hex);
  if (body.length === 0) return null;
  const bytes = hexToBytes(body);
  // Standard ABI string: offset word + length word + data.
  if (bytes.length >= 64) {
    const len = Number(BigInt("0x" + body.slice(64, 128)));
    if (Number.isSafeInteger(len) && len >= 0 && len <= bytes.length - 64) {
      const text = bytesToAscii(bytes.subarray(64, 64 + len));
      if (text != null && isPrintable(text)) return text;
    }
  }
  // Legacy bytes32 form: ASCII padded with zero bytes.
  if (bytes.length === 32) {
    const raw = bytesToAscii(bytes);
    if (raw != null) {
      const text = raw.replace(/\0+$/, "");
      if (text.length > 0 && isPrintable(text)) return text;
    }
  }
  return null;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToAscii(bytes) {
  let text = "";
  for (const b of bytes) {
    if (b === 0) text += "\0";
    else if (b >= 0x20 && b <= 0x7e) text += String.fromCharCode(b);
    else return null;
  }
  return text;
}

function isPrintable(text) {
  return /^[\x20-\x7e]*$/.test(text);
}

/**
 * Format a raw token amount with BigInt-only math. No floats anywhere.
 * formatAmount(1500000n, 6) === "1.5"; formatAmount(1000000n, 6) === "1".
 */
export function formatAmount(amount, decimals) {
  const v = BigInt(amount);
  const d = Number(decimals);
  if (!Number.isInteger(d) || d < 0 || d > 77) throw new Error(`bad decimals: ${decimals}`);
  const negative = v < 0n;
  const digits = (negative ? -v : v).toString().padStart(d + 1, "0");
  const intPart = d === 0 ? digits : digits.slice(0, -d);
  const fracPart = d === 0 ? "" : digits.slice(-d).replace(/0+$/, "");
  const out = fracPart ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${out}` : out;
}

/** Parse a decimal amount string into raw units with BigInt-only math. */
export function parseAmount(text, decimals) {
  const d = Number(decimals);
  if (!/^\d+(\.\d+)?$/.test(String(text).trim())) throw new Error(`bad amount: ${text}`);
  const [intPart, fracPart = ""] = String(text).trim().split(".");
  if (fracPart.length > d) throw new Error(`too many decimals in ${text} for ${d} decimals`);
  return BigInt(intPart) * 10n ** BigInt(d) + BigInt(fracPart.padEnd(d, "0") || "0");
}

/**
 * Decode an Approval event log. Returns null when the log is not a standard
 * ERC-20 Approval event for the expected topic layout.
 */
export function decodeApprovalLog(log) {
  if (!log || !Array.isArray(log.topics) || log.topics.length < 3) return null;
  if (log.topics[0].toLowerCase() !== APPROVAL_TOPIC) return null;
  const owner = "0x" + log.topics[1].slice(-40).toLowerCase();
  const spender = "0x" + log.topics[2].slice(-40).toLowerCase();
  const value = decodeUint256(log.data);
  if (value == null) return null;
  return {
    token: String(log.address).toLowerCase(),
    owner,
    spender,
    value,
    blockNumber: parseInt(log.blockNumber, 16),
    transactionHash: log.transactionHash,
    logIndex: parseInt(log.logIndex ?? "0x0", 16),
  };
}

export function hexBlock(n) {
  return "0x" + BigInt(n).toString(16);
}
