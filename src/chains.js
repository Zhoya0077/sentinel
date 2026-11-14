// Chain configuration. Public RPC endpoints only — no API keys, no secrets.
// The client rotates across endpoints on rate limits / errors and STOPS when
// every endpoint is rate-limiting (see rpc.js). Endpoint order is a
// preference, not a guarantee: any endpoint may be skipped.

export const CHAINS = {
  56: {
    chainId: 56,
    name: "BNB Chain",
    shortName: "BSC",
    explorer: "https://bscscan.com",
    // ~3s blocks. Chunk sizes and windows in scanner.js are tuned for this.
    blockTimeSeconds: 3,
    rpcUrls: [
      "https://bsc-dataseed.binance.org",
      "https://bsc-dataseed1.defibit.io",
      "https://bsc-dataseed1.ninicoin.io",
      "https://bsc.publicnode.com",
      "https://bsc-dataseed2.binance.org",
    ],
  },
  1: {
    chainId: 1,
    name: "Ethereum",
    shortName: "ETH",
    explorer: "https://etherscan.io",
    // ~12s blocks.
    blockTimeSeconds: 12,
    rpcUrls: [
      "https://ethereum.publicnode.com",
      "https://eth.drpc.org",
      "https://eth.llamarpc.com",
    ],
  },
};

export function getChain(chainId) {
  const chain = CHAINS[Number(chainId)];
  if (!chain) throw new Error(`unsupported chain: ${chainId} (supported: ${Object.keys(CHAINS).join(", ")})`);
  return chain;
}

export function explorerAddressUrl(chain, address) {
  return `${chain.explorer}/address/${address}`;
}

export function explorerTxUrl(chain, txHash) {
  return `${chain.explorer}/tx/${txHash}`;
}
