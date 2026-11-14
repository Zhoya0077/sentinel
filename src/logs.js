// Chunked Approval event-log discovery.
//
// The log scan finds (token, spender) pairs the owner has EVER approved
// inside the scanned window. It is the discovery mechanism: allowance()
// checks need a spender address, and only the logs reveal which spenders a
// wallet has used. The scan is windowed by design — full-history discovery
// needs an indexer, which is documented as future work in the writeup.
//
// Chunking is adaptive: if a node rejects a range as too large, the chunk
// halves and retries (down to a floor). RateLimitError from the RPC client
// always propagates: the scan stops instead of hammering.
//
// Address-filter fallback: some free nodes reject eth_getLogs without an
// `address` filter (policy error, e.g. code -32701). When every endpoint
// rejects the topic-only filter, the scan falls back to one query per
// curated token with an address filter, and says so in the warnings. The
// fallback NEVER triggers on rate limits.

import { APPROVAL_TOPIC, decodeApprovalLog, hexBlock, normalizeAddress, padAddress } from "./codec.js";
import { RateLimitError, isPolicyErrorMessage } from "./rpc.js";

const RANGE_ERROR_TEXT = ["range", "too many", "exceed", "limit", "too large", "block range"];

function isRangeError(err) {
  const msg = String(err?.message ?? err).toLowerCase();
  return RANGE_ERROR_TEXT.some((t) => msg.includes(t));
}

/**
 * Scan Approval logs where `owner` is the approver.
 * @returns {{logs: Array, scannedFrom: number, scannedTo: number, warnings: string[]}}
 */
export async function scanApprovalLogs(
  rpc,
  {
    owner,
    fromBlock,
    toBlock,
    chunkSize = 10000,
    minChunkSize = 500,
    chainId = null,
    onProgress = null,
    curatedAddresses = [],
  },
) {
  const ownerTopic = "0x" + padAddress(normalizeAddress(owner));
  const warnings = [];
  const from0 = Number(fromBlock);
  const to = Number(toBlock);

  async function scanRange(addressFilter) {
    const logs = [];
    let from = from0;
    let chunk = Number(chunkSize);
    while (from <= to) {
      const chunkTo = Math.min(from + chunk - 1, to);
      const filter = {
        fromBlock: hexBlock(from),
        toBlock: hexBlock(chunkTo),
        topics: [APPROVAL_TOPIC, ownerTopic],
      };
      if (addressFilter) filter.address = addressFilter;
      try {
        const raw = await rpc.call("eth_getLogs", [filter], { expectedChainId: chainId });
        for (const entry of raw ?? []) {
          const decoded = decodeApprovalLog(entry);
          if (decoded) logs.push(decoded);
        }
        if (onProgress) onProgress({ from, to: chunkTo, found: logs.length, address: addressFilter });
        from = chunkTo + 1;
      } catch (err) {
        if (err instanceof RateLimitError) throw err;
        if (isRangeError(err) && chunk > minChunkSize) {
          chunk = Math.max(minChunkSize, Math.floor(chunk / 2));
          warnings.push(`log range ${from}-${chunkTo} rejected; retrying with ${chunk}-block chunks`);
          continue;
        }
        if (isRangeError(err)) {
          warnings.push(`skipped log range ${from}-${chunkTo}: node rejects even ${chunk}-block chunks (${String(err.message).slice(0, 120)})`);
          from = chunkTo + 1;
          continue;
        }
        throw err;
      }
    }
    return logs;
  }

  try {
    const logs = await scanRange(null);
    return { logs, scannedFrom: from0, scannedTo: to, warnings };
  } catch (err) {
    if (err instanceof RateLimitError) throw err;
    if (isPolicyErrorMessage(err.message) && curatedAddresses.length > 0) {
      warnings.push(
        "public node requires an address filter for eth_getLogs; log discovery limited to curated tokens in this scan",
      );
      const logs = [];
      for (const address of curatedAddresses) {
        const found = await scanRange(address);
        logs.push(...found);
      }
      return { logs, scannedFrom: from0, scannedTo: to, warnings };
    }
    throw err;
  }
}

/** Unique (token, spender) pairs from decoded logs, keeping the earliest log per pair. */
export function uniquePairs(logs) {
  const byKey = new Map();
  for (const log of logs) {
    const key = `${log.token}:${log.spender}`;
    const prev = byKey.get(key);
    if (!prev || log.blockNumber < prev.earliestBlock) {
      byKey.set(key, {
        token: log.token,
        spender: log.spender,
        earliestBlock: log.blockNumber,
        earliestTx: log.transactionHash,
        latestValue: log.value,
        latestBlock: log.blockNumber,
      });
    } else if (log.blockNumber >= prev.latestBlock) {
      prev.latestValue = log.value;
      prev.latestBlock = log.blockNumber;
    }
  }
  return [...byKey.values()];
}
