// Rotating JSON-RPC client over public endpoints.
//
// Behavior contract (this is load-bearing for a guest on free infrastructure):
//  - Endpoints are tried in order, rotating to the next on transport errors,
//    HTTP 5xx, timeouts, and rate-limit responses (429/403, JSON-RPC -32005,
//    "rate limit" / "too many requests" text).
//  - When EVERY endpoint has rate-limited the same call, the client throws
//    RateLimitError and the scan STOPS. It never hammers, never sleeps-and-
//    retries in a loop, and never switches to a different tool to evade.
//  - Non-retryable JSON-RPC errors (bad params, reverted eth_call) fail fast:
//    rotating cannot fix them.
//  - Each endpoint's chain id is verified once (eth_chainId) and cached, so a
//    misconfigured endpoint cannot silently answer for the wrong chain.
//  - `fetchImpl` is injectable for tests; the default is the global fetch, so
//    the same code runs in Node and in the browser demo.

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
    this.code = "RATE_LIMITED";
  }
}

export class RpcError extends Error {
  constructor(message, { code = null } = {}) {
    super(message);
    this.name = "RpcError";
    this.code = code;
  }
}

const RATE_LIMIT_TEXT = ["rate limit", "too many requests", "limit exceeded", "throttl"];
// NOTE: bare "exceeded" is deliberately NOT in this list: node errors about
// a log range ("block range exceeds ...") contain "exceeds" but are NOT rate
// limits, and must reach the adaptive chunking in logs.js instead.

function isRateLimitSignal(status, rpcError, text) {
  if (status === 429) return true;
  if (rpcError && (rpcError.code === -32005 || rpcError.code === 429)) return true;
  const hay = `${rpcError?.message ?? ""} ${text ?? ""}`.toLowerCase();
  if (status === 403 && RATE_LIMIT_TEXT.some((t) => hay.includes(t))) return true;
  return RATE_LIMIT_TEXT.some((t) => hay.includes(t));
}

function isRetryable(status, rpcError) {
  if (status === 0) return true; // transport failure / timeout
  if (status >= 500) return true;
  if (status === 429 || status === 403 || status === 408) return true;
  if (rpcError && [-32005, -32000, -32603].includes(rpcError.code)) return true;
  if (rpcError && isPolicyError(rpcError)) return true;
  return false;
}

// Some free nodes reject certain request SHAPES as policy (e.g. eth_getLogs
// without an address filter, code -32701). That is endpoint policy, not a
// malformed request and not a rate limit: rotate to the next endpoint, and
// let the caller decide on a shape fallback (see logs.js).
const POLICY_ERROR_TEXT = ["specify an address", "address in your request"];

export function isPolicyError(rpcError) {
  if (rpcError?.code === -32701) return true;
  const msg = String(rpcError?.message ?? "").toLowerCase();
  return POLICY_ERROR_TEXT.some((t) => msg.includes(t));
}

export function isPolicyErrorMessage(text) {
  return POLICY_ERROR_TEXT.some((t) => String(text ?? "").toLowerCase().includes(t));
}

export function createRpcClient(endpoints, options = {}) {
  const urls = [...endpoints];
  const timeoutMs = options.timeoutMs ?? 12000;
  const cooldownMs = options.cooldownMs ?? 60000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const chainIdCache = new Map(); // url -> chainId number
  const cooldownUntil = new Map(); // url -> timestamp; dead/limiting endpoints are skipped briefly
  let cursor = 0;
  let idCounter = 1;

  function cooledDown(url) {
    const until = cooldownUntil.get(url);
    return until != null && Date.now() < until;
  }

  function markCooldown(url) {
    cooldownUntil.set(url, Date.now() + cooldownMs);
  }

  async function post(url, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // Non-JSON body (HTML error page, empty body): treat as transport error.
        throw new RpcError(`non-JSON response from ${url} (HTTP ${res.status})`, { code: "NON_JSON" });
      }
      return { status: res.status, json, text };
    } catch (err) {
      if (err?.name === "AbortError") {
        throw new RpcError(`timeout after ${timeoutMs}ms from ${url}`, { code: "TIMEOUT" });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function call(method, params = [], { expectedChainId = null } = {}) {
    const tried = [];
    const limitedThisCall = new Set();
    let lastError = null;
    // Prefer endpoints that are not cooling down; if all are cooling down,
    // try them anyway (cooldowns are advisory, never a hard block).
    const ordered = urls.map((_, i) => urls[(cursor + i) % urls.length]);
    const available = ordered.filter((u) => !cooledDown(u));
    const candidates = available.length > 0 ? available : ordered;
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const url = candidates[attempt];
      tried.push(url);
      try {
        const { status, json } = await post(url, {
          jsonrpc: "2.0",
          id: idCounter++,
          method,
          params,
        });
        if (json.error) {
          if (isRateLimitSignal(status, json.error, "")) {
            limitedThisCall.add(url);
            markCooldown(url);
            lastError = new RpcError(`rate limited by ${url}: ${json.error.message}`, { code: json.error.code });
            continue;
          }
          if (isRetryable(status, json.error)) {
            lastError = new RpcError(`${url}: ${json.error.message}`, { code: json.error.code });
            continue;
          }
          throw new RpcError(`${url}: ${json.error.message}`, { code: json.error.code });
        }
        if (status === 429 || status === 403) {
          limitedThisCall.add(url);
          markCooldown(url);
          lastError = new RpcError(`rate limited by ${url} (HTTP ${status})`);
          continue;
        }
        if (status >= 400) {
          lastError = new RpcError(`${url} returned HTTP ${status}`);
          if (isRetryable(status, null)) continue;
          throw lastError;
        }
        // Success: clear any cooldown, advance the cursor so load spreads,
        // and verify the chain id once per endpoint.
        cooldownUntil.delete(url);
        cursor = (urls.indexOf(url) + 1) % urls.length;
        if (expectedChainId != null && method !== "eth_chainId") {
          await verifyChainId(url, expectedChainId);
        }
        return json.result;
      } catch (err) {
        if (err instanceof RpcError && err.code === "NON_JSON") {
          markCooldown(url);
          lastError = err;
          continue;
        }
        if (err instanceof RpcError && (err.code === "TIMEOUT" || err.message.includes("timeout"))) {
          markCooldown(url);
          lastError = err;
          continue;
        }
        if (err instanceof TypeError || err?.cause) {
          // fetch-level network failure: cool down and rotate.
          markCooldown(url);
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    // Stop when every endpoint either rate-limited this call or is cooling
    // down from a recent failure — at least one fresh limit signal required.
    const allLimitedOrCooling =
      limitedThisCall.size > 0 && urls.every((u) => limitedThisCall.has(u) || cooledDown(u));
    if (allLimitedOrCooling) {
      throw new RateLimitError(
        `all ${urls.length} RPC endpoints rate-limited or unavailable; stopping instead of retrying (tried: ${tried.join(", ")})`,
      );
    }
    throw lastError ?? new RpcError("all RPC endpoints failed");
  }

  async function verifyChainId(url, expectedChainId) {
    if (chainIdCache.has(url)) {
      const cached = chainIdCache.get(url);
      if (cached !== Number(expectedChainId)) {
        throw new RpcError(`endpoint ${url} serves chain ${cached}, expected ${expectedChainId}`);
      }
      return;
    }
    const { json } = await post(url, { jsonrpc: "2.0", id: idCounter++, method: "eth_chainId", params: [] });
    if (json.error) throw new RpcError(`${url}: eth_chainId failed: ${json.error.message}`);
    const actual = parseInt(json.result, 16);
    chainIdCache.set(url, actual);
    if (actual !== Number(expectedChainId)) {
      throw new RpcError(`endpoint ${url} serves chain ${actual}, expected ${expectedChainId}`);
    }
  }

  return { call, endpoints: urls };
}

/** Tiny concurrency limiter: at most `max` async jobs in flight. */
export function createLimiter(max) {
  let inFlight = 0;
  const queue = [];
  const pump = () => {
    while (inFlight < max && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      inFlight++;
      fn()
        .then(resolve, reject)
        .finally(() => {
          inFlight--;
          pump();
        });
    }
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      pump();
    });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
