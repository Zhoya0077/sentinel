# Sentinel — a wallet-approval security agent

Sentinel audits ERC-20 token approvals for any EVM wallet, scores each
approval's risk from on-chain facts, and generates the exact calldata needed
to revoke the risky ones. It is **read-only**: it never signs, never
broadcasts, never connects a wallet, and never asks for a key. You review the
calldata and sign in your own wallet.

Built for the [Agent Games](https://agentgames.zkverify.io) Wildcard track
(Season 01, closes 21 Nov 2026). See `writeup.md` for the full submission
write-up: problem, design, verification, and limitations.

## The problem

Approving a token lets a contract move that token on your behalf — often an
*unlimited* amount, forever, including tokens you deposit later. Unlimited
approvals to contracts that later get exploited, or to addresses you no
longer trust, are one of the most common ways wallets lose funds. Most people
never review their approvals because no tool shows them plainly, with the
risk explained and the fix one careful step away.

## How it works

```
scan ──> score ──> recommend ──> revoke calldata
  ^                                  |
  └────────── watch mode ────────────┘
```

1. **Discover.** Sentinel scans `Approval` event logs for the wallet in a
   recent block window (adaptive chunking; falls back to per-token queries
   when a node requires an address filter), and sweeps a curated list of major
   tokens × verified protocol spenders so old approvals surface even without
   log history.
2. **Verify current state.** For every discovered (token, spender) pair it
   reads the *current* `allowance()` on-chain. Ground truth wins: pairs whose
   allowance is now zero are dropped, never reported as live risk. Token
   metadata (`decimals`, `symbol`) is read from the chain, never assumed.
3. **Score transparently.** Every point comes from an on-chain fact (formula
   below). No invented denylists: a spender that is not on the small verified
   list is "unrecognized — verify before trusting", never "malicious".
4. **Recommend + generate.** HIGH/CRITICAL approvals get a revoke
   recommendation with exact `approve(spender, 0)` calldata, round-trip
   verified (decode → re-encode → must match) before it is shown, plus a
   human-readable explanation and a verify-before-signing checklist.
5. **Watch.** `watch` re-scans on an interval and reports only what changed:
   new approvals, removed approvals, changed allowances.

### Risk formula (auditable, no hidden weights)

| Signal | Points |
|---|---|
| Unlimited allowance (`type(uint256).max`) | +50 |
| Allowance covers the full current balance | +20 |
| Spender is an EOA (no contract code) | +15 |
| Spender not on the verified known-protocol list | +10 |
| Approval ≥ 180 days old (≥ 30 days: +5) | +10 |
| Current exposure > $1,000 (approx. USD; > $100: +5) | +10 |

Levels: **≥70 CRITICAL, ≥40 HIGH, ≥20 MEDIUM, else LOW.** A recognized
spender earns no "unrecognized" points, but an unlimited approval to a known
protocol is still HIGH — unlimited is unlimited. USD figures are approximate
display aids (CoinGecko, best-effort); scoring proceeds without them.

### Verifiability

Every report carries the scanned block range and a SHA-256 hash of a
canonical report (stable JSON: sorted keys, BigInt as decimal strings, no
timestamps inside the hashed payload). Anyone can re-run the same read-only
scan and compare hashes. There is no ZK proof in v1 — zkVerify attestation
is documented as future work in `writeup.md`, not claimed.

### Rate-limit discipline

Sentinel is a guest on free public RPCs. It rotates endpoints, cools down
dead or limiting endpoints briefly, caps concurrency, and **stops** — marking
the report PARTIAL — when every endpoint rate-limits, instead of hammering.
It never sleeps-and-retries in a loop.

## Usage

Zero runtime dependencies. Node ≥ 20.

```sh
# Scan a wallet on both chains (BSC + Ethereum)
node bin/sentinel.js scan 0xF27D1f38eDd79038908ff8d79eff19079b901bF5

# One chain, smaller log window, JSON output
node bin/sentinel.js scan 0xF27D... --chain 56 --blocks 100000 --json

# Watch mode: re-scan every 5 minutes, report only changes
node bin/sentinel.js watch 0xF27D... --interval 300

# Revoke calldata for one approval (prints calldata + explanation; never signs)
node bin/sentinel.js revoke <token-address> <spender-address>

# Decode approve() calldata before signing it
node bin/sentinel.js decode 0x095ea7b3...
```

Or install the `sentinel` command with `npm link` (repo root).

### Demo

`demo/index.html` is a self-contained page that runs the same scanner in the
browser: paste an address, pick a chain, get the report. No wallet connection,
no server, no setup. It calls public RPC endpoints directly from your
browser. A hosted copy is linked from the submission.

## Tests

```sh
npm test   # node:test, mocked transports — no network needed
```

60 tests pass, covering: ABI codec round-trips, risk scoring bands, revoke
calldata exact bytes + decode, RPC rotation / rate-limit stop / endpoint
cooldowns, log-scan chunking + address-filter fallback, scanner merge/dedupe/
zero-filtering, report canonicalization, and watch-mode diffing. An optional
selector cross-check against ethers (10 tests, skipped when ethers is not
installed) independently verifies every hand-written function selector and
the Approval event topic.

## Project layout

```
sentinel/
  bin/sentinel.js      CLI: scan / watch / revoke / decode
  src/
    codec.js           minimal ABI codec (BigInt-only, no floats)
    chains.js          chain + public RPC endpoint config
    tokens.js          curated major-token candidates (verified on-chain)
    knownSpenders.js   small verified list of known protocol contracts
    rpc.js             rotating RPC client + rate-limit stop + cooldowns
    erc20.js           read-only ERC-20 reads (eth_call / eth_getCode)
    logs.js            chunked Approval log discovery + fallback
    risk.js            transparent risk scoring + exposure math
    revoke.js          approve(spender, 0) calldata + decode + explanation
    prices.js          optional CoinGecko pricing (best-effort)
    scanner.js         orchestrates discovery -> verify -> score -> calldata
    report.js          text/markdown/JSON rendering + canonical hashing input
    agent.js           scan -> recommend loop, diffing, watch mode
    index.js           public API surface
  test/                node:test suites (mocked transports)
  demo/index.html      self-contained browser demo (same logic, client-side)
  writeup.md           submission write-up
```

## Limitations (honest)

- **Windowed log discovery.** Approvals granted before the scanned window
  are found only if the spender is a known protocol in the sweep, or the
  token is in the curated list. Full-history discovery needs an indexer.
- **Free RPCs are flaky.** BSC public endpoints aggressively rate-limit
  `eth_getLogs`; when that happens Sentinel stops and says PARTIAL rather
  than guessing. A judge on a fresh IP, or a smaller `--blocks` window,
  usually succeeds.
- **Prices are approximate.** USD exposure is a prioritization aid, never a
  transaction amount. If pricing fails, reports show `n/a` and scoring
  continues.
- **Reputation is a short verified list.** Most spenders will show as
  "unrecognized". That is a statement about Sentinel's knowledge, not an
  accusation about the spender.

## Safety

- No private keys, no seed phrases, no wallet connections — ever.
- No signing, no broadcasting. Revoke calldata is for the user to review and
  sign in their own wallet, after the printed checks.
- All amount math in BigInt; token decimals always read via `decimals()`.
- No secrets in this repo. Public RPC endpoints only, no API keys.

## License

MIT — see `LICENSE`.
