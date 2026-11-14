# Sentinel — write-up (Agent Games Wildcard)

**Agent:** Sentinel, a wallet-approval security agent.
**Author:** @haifarc.
**Links:** repository + public demo (see submission form).
**Status:** v1, working. Read-only; no signing, no wallet connection.

## The problem

An ERC-20 `approve()` lets another address move your tokens — and most
approvals people grant are *unlimited* (`type(uint256).max`) and *permanent*.
The spender can drain not just today's balance but anything deposited later,
until the approval is revoked. Unlimited approvals to contracts that are
later exploited, abandoned, or simply no longer needed are one of the most
common ways wallets lose funds.

Yet almost nobody reviews their approvals. The information is scattered
across event logs and per-token `allowance()` calls; the risk of each
approval is never explained in plain language; and the fix — a precise
`approve(spender, 0)` transaction — requires calldata most users cannot
write or verify by hand.

## Who it helps

- **Everyday wallet users** who have ever clicked "approve" on a DEX or an
  NFT mint and want to know what is still live, in plain language, with the
  fix ready to review.
- **AI-agent operators** whose agents hold wallets and grant approvals
  programmatically: Sentinel watches those wallets continuously and reports
  only what changed.
- **Auditors and support helpers** who need a quick, verifiable, read-only
  approval report for any address, without asking for keys or a connection.

## What it does

Given an EVM address and a chain (BNB Chain and Ethereum in v1), Sentinel:

1. Discovers the wallet's ERC-20 approvals from `Approval` event logs plus
   a known-spender sweep (curated major tokens × verified protocol contracts).
2. Reads the **current** allowance for every pair on-chain — current state is
   ground truth; revoked or spent approvals are dropped, never reported.
3. Scores each live approval with a transparent, documented formula based on
   on-chain facts: unlimited vs exact amount, spender type (EOA vs contract),
   recognized vs unrecognized spender, approval age, and approximate USD
   exposure.
4. Recommends action (revoke now / review soon / ok) and generates the exact
   `approve(spender, 0)` calldata for risky approvals, round-trip verified,
   with a human-readable decode and a verify-before-signing checklist.
5. In watch mode, re-scans autonomously and reports only diffs: new, removed,
   and changed approvals.

The browser demo does all of this client-side: paste an address, pick a
chain, get the report. Zero setup, no wallet connection, no server.

## How it works

### Architecture

Zero-dependency core (Node ≥ 20 and browser share the same code):

- **Codec** — a minimal hand-written ABI codec for the six ERC-20 calls
  Sentinel needs, with BigInt-only arithmetic. Every selector is
  independently cross-checked against ethers in an optional test.
- **RPC client** — rotates public endpoints, verifies each endpoint's chain
  id, cools down dead/limiting endpoints, caps concurrency, and **stops**
  (marking the report PARTIAL) when every endpoint rate-limits.
- **Discovery** — chunked `eth_getLogs` with adaptive chunk halving on range
  errors, plus an address-filter fallback for nodes that require one; the
  known-spender sweep catches old approvals to known protocols without logs.
- **Scoring** — pure function of on-chain facts; the formula is in the README
  and every report lists the reasons behind each score.
- **Revoke helper** — builds `approve(spender, 0)` calldata and refuses to
  emit it unless decode → re-encode reproduces the exact bytes.

### Key decisions

1. **Read-only by construction.** There is no signing code, no wallet
   connector, no private-key handling anywhere in the repo. The product's
   thesis — *decode before signing, minimal allowances, exact amounts* — is
   enforced by what the code cannot do, not by a promise.
2. **Current state beats history.** Logs say what *was* approved; only
   `allowance()` says what is live *now*. Sentinel reports the latter.
3. **Decimals from the chain, math in BigInt.** Token decimals are read via
   `decimals()` for every token (BSC USDT/USDC use 18 decimals, Ethereum
   USDT/USDC use 6 — assuming either would corrupt every amount). No floats
   anywhere in amount math.
4. **Honest reputation.** The known-spender list is short and every entry is
   verified against a documented public source or an on-chain check. Anything
   else is "unrecognized — verify before trusting". Sentinel never invents a
   denylist and never calls an address malicious on no evidence.
5. **Stop, don't hammer.** Free RPCs are shared infrastructure. On rate
   limits Sentinel stops and says so, loudly, in the report — a partial
   report labelled PARTIAL is worth more than a guessed complete one.
6. **No fake verifiability.** Reports carry a SHA-256 hash of a canonical
   report so anyone can re-run the read-only scan and compare. That is the
   verifiability v1 honestly offers. No ZK proof is claimed (see below).

## What makes it agentic

Sentinel is not a one-shot script: it runs a loop — **scan → score →
recommend → generate** — and in watch mode it runs that loop autonomously on
a schedule, maintains state (the previous report), diffs against it, and
surfaces only changes. The loop's decisions (which pairs to check, when to
stop, what to recommend) are driven by live on-chain data and the documented
scoring policy, not by a human in the loop. The human stays in the loop
exactly where they must: reviewing and signing the revoke transaction.

## How to verify (for judges)

1. **Run the tests:** `npm test` — 60 tests, mocked transports, no network.
   They cover the codec, scoring, revoke calldata bytes, RPC rotation and
   rate-limit stop, log chunking and fallback, scanner merge/dedupe, report
   canonicalization, and watch diffing.
2. **Run a live scan:** `node bin/sentinel.js scan <any-address> --chain 1
   --blocks 5000` and compare any reported allowance against Etherscan's
   token approval checker or a direct `allowance()` call.
3. **Check the calldata:** `node bin/sentinel.js decode <calldata>` prints
   the spender and amount; verify the amount is exactly 0 and the spender
   matches the report.
4. **Check the hash:** re-run the same scan; the report hash in the output
   matches when the underlying approvals and block range are unchanged.
5. **Try the demo:** paste an address, no wallet needed. If a public RPC
   rate-limits the request, the demo says so instead of showing stale or
   invented data.

A live smoke test during development found a real unlimited DAI approval to
Uniswap SwapRouter02 on Ethereum, scored HIGH (50), with correct balance and
revoke calldata — the pipeline works on real chain data, not fixtures.

## Limitations

- **Windowed discovery.** Log discovery covers a recent block window
  (defaults: 500k blocks BSC, 50k Ethereum; demo uses smaller windows).
  Older approvals surface only via the known-spender sweep. Full-history
  discovery needs an indexer — the natural next step.
- **Free-RPC flakiness.** BSC public endpoints aggressively limit
  `eth_getLogs`; scans stop and report PARTIAL when limited. Smaller windows
  or a retry later usually succeed.
- **Short reputation list.** Most spenders show as unrecognized. That is a
  statement about Sentinel's knowledge, not an accusation.
- **Approximate USD.** Prices are a best-effort display aid; reports show
  `n/a` when pricing is unavailable and scoring continues.

## zkVerify (optional) — future work, not claimed

v1 makes no ZK claim. The natural zkVerify integration is a **proof-of-scan
attestation**: a Groth16 proof that a scan was performed over a stated block
range with a stated scoring policy, verifiable by anyone without re-running
the scan — with the proof reference and `vk_hash` published alongside the
report hash. That work needs a circuit for the scan's deterministic core and
is out of scope for v1; it is documented here as the honest next step, not
implied to exist.

## Safety

No keys, no signing, no wallet connections, no spending. All amount math in
BigInt; decimals always from `decimals()`. No secrets in the repo. Public
RPC endpoints only, no API keys.
