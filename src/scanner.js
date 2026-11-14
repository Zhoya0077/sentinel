// Scanner: the heart of Sentinel. For one owner address on one chain:
//   1. Discover (token, spender) pairs from Approval event logs in the
//      scanned window (logs.js).
//   2. Add known-spender sweep pairs: curated tokens x verified spenders,
//      so old approvals to known protocols surface without log history.
//   3. For every pair, read the CURRENT allowance on-chain. Current state is
//      ground truth: pairs whose allowance is now 0 are dropped (revoked or
//      fully spent), never reported as live risk.
//   4. For live pairs, read balance, token metadata (decimals from the
//      chain), spender code, approval age, and an approximate price; then
//      score and attach revoke calldata.
//
// Errors: RateLimitError propagates and the scan stops, returning a
// clearly-marked PARTIAL report via the caller. Individual non-fatal read
// failures for one pair produce a warning and skip that pair, never a
// fabricated entry.

import { MAX_UINT256, normalizeAddress } from "./codec.js";
import { getChain } from "./chains.js";
import { curatedTokens } from "./tokens.js";
import { KNOWN_SPENDERS, knownSpender } from "./knownSpenders.js";
import { createLimiter } from "./rpc.js";
import { getAllowance, getBalance, getBlockNumber, getBlockTimestamp, getTokenMeta, isEOA } from "./erc20.js";
import { scanApprovalLogs, uniquePairs } from "./logs.js";
import { exposureUsdCents, scoreApproval } from "./risk.js";
import { buildRevokeCalldata, explainRevoke } from "./revoke.js";
import { fetchPrices } from "./prices.js";

export const DEFAULT_WINDOWS = {
  56: { blocks: 500000, chunkSize: 10000 },
  1: { blocks: 50000, chunkSize: 10000 },
};

export async function scanChain(rpc, owner, chainId, options = {}) {
  const chain = getChain(chainId);
  const ownerNorm = normalizeAddress(owner);
  const warnings = [];
  const latestBlock = await getBlockNumber(rpc, chainId);
  const window = options.blocks ?? DEFAULT_WINDOWS[chainId]?.blocks ?? 100000;
  const fromBlock = Math.max(0, latestBlock - window);
  const chunkSize = options.chunkSize ?? DEFAULT_WINDOWS[chainId]?.chunkSize ?? 10000;

  // 1. Log discovery.
  const { logs, warnings: logWarnings } = await scanApprovalLogs(rpc, {
    owner: ownerNorm,
    fromBlock,
    toBlock: latestBlock,
    chunkSize,
    chainId,
    onProgress: options.onProgress,
    curatedAddresses: curatedTokens(chainId).map((t) => t.address),
  });
  warnings.push(...logWarnings);
  const pairs = new Map();
  for (const p of uniquePairs(logs)) pairs.set(`${p.token}:${p.spender}`, p);

  // 2. Known-spender sweep: curated tokens x verified spenders on this chain.
  const sweepPairs = [];
  const spenders = KNOWN_SPENDERS[chainId] ?? [];
  for (const token of curatedTokens(chainId)) {
    for (const spender of spenders) {
      const key = `${token.address}:${spender.address}`;
      if (!pairs.has(key)) {
        sweepPairs.push({ token: token.address, spender: spender.address, earliestBlock: null, earliestTx: null });
        pairs.set(key, sweepPairs[sweepPairs.length - 1]);
      }
    }
  }

  // 3. Token metadata (verified on-chain). Tokens that fail metadata are
  // skipped entirely — a bad address can never produce a report entry.
  const limit = createLimiter(options.concurrency ?? 5);
  const tokensByAddress = new Map();
  const tokenHints = new Map(curatedTokens(chainId).map((t) => [t.address, t]));
  await Promise.all(
    [...new Set([...pairs.values()].map((p) => p.token))].map((token) =>
      limit(async () => {
        const meta = await getTokenMeta(rpc, token, chainId).catch((err) => {
          if (err?.name === "RateLimitError") throw err;
          warnings.push(`token ${token}: metadata read failed (${String(err.message).slice(0, 100)})`);
          return null;
        });
        if (meta) tokensByAddress.set(token, meta);
      }),
    ),
  );

  // 4. Current allowances, balances, spender code, age, scoring.
  const prices = await fetchPrices(
    [...tokensByAddress.values()].map((m) => tokenHints.get(m.address)?.coingeckoId).filter(Boolean),
    { fetchImpl: options.fetchImpl ?? null },
  );
  const nowSeconds = Math.floor(Date.now() / 1000);
  const earliestTimestamps = new Map();
  const approvals = [];

  await Promise.all(
    [...pairs.values()].map((pair) =>
      limit(async () => {
        const meta = tokensByAddress.get(pair.token);
        if (!meta) return;
        let allowance;
        try {
          allowance = await getAllowance(rpc, pair.token, ownerNorm, pair.spender, chainId);
        } catch (err) {
          if (err?.name === "RateLimitError") throw err;
          warnings.push(`allowance ${pair.token} -> ${pair.spender} failed (${String(err.message).slice(0, 100)})`);
          return;
        }
        if (allowance == null || allowance === 0n) return; // revoked / spent: no live risk
        const [balance, spenderEOA] = await Promise.all([
          getBalance(rpc, pair.token, ownerNorm, chainId).catch((err) => {
            if (err?.name === "RateLimitError") throw err;
            return 0n;
          }),
          isEOA(rpc, pair.spender, chainId).catch((err) => {
            if (err?.name === "RateLimitError") throw err;
            return null;
          }),
        ]);
        let ageDays = null;
        if (pair.earliestBlock != null) {
          if (!earliestTimestamps.has(pair.earliestBlock)) {
            const ts = await getBlockTimestamp(rpc, pair.earliestBlock, chainId).catch((err) => {
              if (err?.name === "RateLimitError") throw err;
              return null;
            });
            earliestTimestamps.set(pair.earliestBlock, ts);
          }
          const ts = earliestTimestamps.get(pair.earliestBlock);
          if (ts != null) ageDays = (nowSeconds - ts) / 86400;
        }
        const priceCents = prices.get(tokenHints.get(pair.token)?.coingeckoId);
        const exposure = exposureUsdCents(allowance, balance ?? 0n, meta.decimals, priceCents ?? null);
        const known = knownSpender(chainId, pair.spender);
        const scored = scoreApproval({
          allowance,
          balance: balance ?? 0n,
          decimals: meta.decimals,
          spenderIsEOA: spenderEOA === true,
          knownSpender: known,
          ageDays,
          exposureUsdCents: exposure == null ? null : Number(exposure),
        });
        const calldata = buildRevokeCalldata(pair.spender);
        approvals.push({
          chainId,
          token: pair.token,
          tokenSymbol: meta.symbol ?? tokenHints.get(pair.token)?.hint ?? null,
          tokenName: meta.name,
          decimals: meta.decimals,
          spender: pair.spender,
          spenderLabel: known?.label ?? null,
          spenderIsEOA: spenderEOA,
          allowance,
          balance: balance ?? 0n,
          unlimited: scored.unlimited,
          ageDays: ageDays == null ? null : Math.floor(ageDays),
          earliestBlock: pair.earliestBlock,
          earliestTx: pair.earliestTx,
          discoveredVia: pair.earliestBlock != null ? "approval-log" : "known-spender-sweep",
          priceUsdCents: priceCents ?? null,
          exposureUsdCents: exposure,
          score: scored.score,
          level: scored.level,
          reasons: scored.reasons,
          revokeCalldata: calldata,
          revokeExplanation: explainRevoke({
            token: pair.token,
            tokenSymbol: meta.symbol ?? tokenHints.get(pair.token)?.hint ?? "token",
            spender: pair.spender,
            spenderLabel: known?.label ?? null,
          }),
        });
      }),
    ),
  );

  approvals.sort((a, b) => b.score - a.score || (a.token < b.token ? -1 : 1));

  return {
    owner: ownerNorm,
    chainId,
    chainName: chain.name,
    scannedFromBlock: fromBlock,
    scannedToBlock: latestBlock,
    scannedAt: new Date().toISOString(),
    pairsConsidered: pairs.size,
    approvals,
    warnings,
    partial: false,
  };
}

/** Scan several chains and merge. A rate-limit failure on one chain marks
 *  the whole report partial and stops further chains. */
export async function scanAll(rpcForChain, owner, chainIds, options = {}) {
  const chains = [];
  let partial = false;
  const warnings = [];
  for (const chainId of chainIds) {
    try {
      const report = await scanChain(rpcForChain(chainId), owner, chainId, options);
      chains.push(report);
      warnings.push(...report.warnings);
    } catch (err) {
      if (err?.name === "RateLimitError") {
        partial = true;
        warnings.push(`chain ${chainId}: stopped on rate limit — report is PARTIAL (${err.message})`);
        break;
      }
      throw err;
    }
  }
  return {
    owner: normalizeAddress(owner),
    scannedAt: new Date().toISOString(),
    chains,
    warnings,
    partial,
  };
}

export { MAX_UINT256 };
