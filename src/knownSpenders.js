// Small, verified list of well-known protocol contracts that commonly hold
// token approvals. Used ONLY to label a spender "recognized" in reports.
//
// Every entry was verified against a documented public source at build time
// (see `source` + `verified` per entry). Sentinel NEVER invents a denylist
// and NEVER calls an unrecognized spender malicious: an address that is not
// on this list is reported as "unrecognized — verify before trusting", and
// the risk score says so explicitly. Inclusion here is not an endorsement and
// does not lower the score of an unlimited approval to zero: unlimited is
// unlimited, whoever holds it.
//
// Verification methods used:
//  - docs: the address appears in the protocol's official deployment feed.
//  - onchain: the contract's own factory()/WETH() getters were read on-chain
//    and returned the protocol's documented factory + wrapped-native token.

export const KNOWN_SPENDERS = {
  1: [
    {
      address: "0x7a250d5630b4cf539739df2c5dacb4c659f2488d",
      label: "Uniswap V2 Router",
      source: "on-chain verification only (see verified field); no docs URL claimed",
      verified: "onchain: factory()=0x5c69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f, WETH()=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
    },
    {
      address: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
      label: "Uniswap SwapRouter02",
      source: "https://developers.uniswap.org/deployments.json (v3-swaprouter02-ethereum, generated 2026-11-04)",
      verified: "docs",
    },
    {
      address: "0x23617e59a5925b2a4bf75d73ff6711cd0b29de85",
      label: "Uniswap Universal Router",
      source: "https://developers.uniswap.org/deployments.json (universal-router-universalrouter-ethereum, generated 2026-11-04)",
      verified: "docs",
    },
  ],
  56: [
    {
      address: "0x10ed43c718714eb63d5aa57b78b54704e256024e",
      label: "PancakeSwap V2 Router",
      source: "https://docs.pancakeswap.finance/developers/smart-contracts",
      verified: "onchain: factory()=0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73, WETH()=WBNB",
    },
    {
      address: "0xb971ef87ede563556b2ed4b1c0b0019111dd85d2",
      label: "Uniswap SwapRouter02",
      source: "https://developers.uniswap.org/deployments.json (v3-swaprouter02-bnb-chain, generated 2026-11-04)",
      verified: "docs",
    },
    {
      address: "0xdc264714f68d84cf29bc605589405e78bdbe7c9f",
      label: "Uniswap Universal Router",
      source: "https://developers.uniswap.org/deployments.json (universal-router-universalrouter-bnb-chain, generated 2026-11-04)",
      verified: "docs",
    },
  ],
};

export function knownSpender(chainId, address) {
  const list = KNOWN_SPENDERS[Number(chainId)] ?? [];
  return list.find((s) => s.address === String(address).toLowerCase()) ?? null;
}
