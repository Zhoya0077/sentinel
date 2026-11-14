// Read-only ERC-20 reads over eth_call / eth_getCode. Every value that
// matters (decimals, allowance, balance) comes from the chain at scan time.
// Nothing here signs, sends, or estimates gas — reads only.

import {
  SELECTORS,
  decodeAddress,
  decodeString,
  decodeUint256,
  encodeAllowanceCall,
  encodeBalanceOfCall,
  encodeCall,
  hexBlock,
  normalizeAddress,
} from "./codec.js";

function rethrowRateLimit(err) {
  if (err?.name === "RateLimitError") throw err;
  return null;
}

export async function ethCall(rpc, { to, data, block = "latest", chainId = null }) {
  return rpc.call("eth_call", [{ to, data }, block], { expectedChainId: chainId });
}

export async function getBlockNumber(rpc, chainId = null) {
  const hex = await rpc.call("eth_blockNumber", [], { expectedChainId: chainId });
  return parseInt(hex, 16);
}

export async function getBlockTimestamp(rpc, blockNumber, chainId = null) {
  const block = await rpc.call(
    "eth_getBlockByNumber",
    [hexBlock(blockNumber), false],
    { expectedChainId: chainId },
  );
  if (!block) return null;
  return parseInt(block.timestamp, 16);
}

/**
 * Read token metadata from the chain. Returns null when the address is not
 * an ERC-20 (decimals() returns no data). symbol/name failures are tolerated
 * — decimals is the load-bearing field.
 */
export async function getTokenMeta(rpc, tokenAddress, chainId = null) {
  const token = normalizeAddress(tokenAddress);
  const [decRaw, symRaw, nameRaw] = await Promise.all([
    ethCall(rpc, { to: token, data: SELECTORS.decimals, chainId }).catch(rethrowRateLimit),
    ethCall(rpc, { to: token, data: SELECTORS.symbol, chainId }).catch(rethrowRateLimit),
    ethCall(rpc, { to: token, data: SELECTORS.name, chainId }).catch(rethrowRateLimit),
  ]);
  const decimalsBig = decRaw == null ? null : decodeUint256(decRaw);
  if (decimalsBig == null) return null;
  const decimals = Number(decimalsBig);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) return null;
  return {
    address: token,
    decimals,
    symbol: symRaw == null ? null : decodeString(symRaw),
    name: nameRaw == null ? null : decodeString(nameRaw),
  };
}

export async function getAllowance(rpc, token, owner, spender, chainId = null) {
  const raw = await ethCall(rpc, {
    to: normalizeAddress(token),
    data: encodeAllowanceCall(owner, spender),
    chainId,
  });
  return decodeUint256(raw);
}

export async function getBalance(rpc, token, owner, chainId = null) {
  const raw = await ethCall(rpc, {
    to: normalizeAddress(token),
    data: encodeBalanceOfCall(owner),
    chainId,
  });
  return decodeUint256(raw);
}

/** True when the address has no contract code (an externally-owned account). */
export async function isEOA(rpc, address, chainId = null) {
  const code = await rpc.call("eth_getCode", [normalizeAddress(address), "latest"], {
    expectedChainId: chainId,
  });
  return code === "0x" || code === "0X0" || code == null;
}

export async function getFactoryAndWeth(rpc, routerAddress, chainId = null) {
  const [factoryRaw, wethRaw] = await Promise.all([
    ethCall(rpc, { to: routerAddress, data: SELECTORS.factory, chainId }).catch(rethrowRateLimit),
    ethCall(rpc, { to: routerAddress, data: SELECTORS.weth, chainId }).catch(rethrowRateLimit),
  ]);
  return {
    factory: factoryRaw == null ? null : decodeAddress(factoryRaw),
    weth: wethRaw == null ? null : decodeAddress(wethRaw),
  };
}

export { encodeCall };
