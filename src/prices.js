// Optional approximate-USD pricing via the public CoinGecko simple-price
// endpoint (no key). Prices are a DISPLAY AID for prioritization only: the
// risk score uses coarse $100/$1,000 bands, and every USD figure is labelled
// approximate. Any failure (network, rate limit, bad response) degrades
// gracefully to "price unavailable" — the scan never depends on it.

const COINGECKO_URL = "https://api.coingecko.com/api/v3/simple/price";

/**
 * @param {string[]} ids - CoinGecko ids, e.g. ["tether", "usd-coin"].
 * @returns {Promise<Map<string, bigint>>} id -> price in integer USD cents.
 * Never throws: returns an empty map on any failure.
 */
export async function fetchPrices(ids, { fetchImpl = null, timeoutMs = 8000 } = {}) {
  const out = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return out;
  const doFetch = fetchImpl ?? globalThis.fetch.bind(globalThis);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await doFetch(
        `${COINGECKO_URL}?ids=${encodeURIComponent(unique.join(","))}&vs_currencies=usd`,
        { headers: { accept: "application/json" }, signal: controller.signal },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return out;
    const json = await res.json();
    for (const id of unique) {
      const usd = json?.[id]?.usd;
      if (typeof usd === "number" && Number.isFinite(usd) && usd >= 0) {
        out.set(id, BigInt(Math.round(usd * 100)));
      }
    }
  } catch {
    // Pricing is best-effort; callers treat a missing price as "unknown".
  }
  return out;
}
