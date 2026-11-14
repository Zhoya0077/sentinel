// Curated major-token candidate lists, one per chain.
//
// These addresses are CANDIDATES ONLY. Sentinel never trusts this list for
// anything that matters: every token is verified on-chain via decimals()
// (and symbol()/name() where available) before it is used, and every amount
// is decoded with the decimals read from the chain. A stale or wrong entry
// is skipped with a warning, never reported.
//
// `coingeckoId` is used only for the optional approximate-USD display aid
// (see prices.js). WBNB/WETH/BTCB/WBTC are priced via their underlying
// asset and labelled approximate.

export const CURATED_TOKENS = {
  56: [
    { address: "0x55d398326f99059ff775485246999027b3197955", hint: "USDT", coingeckoId: "tether" },
    { address: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", hint: "USDC", coingeckoId: "usd-coin" },
    { address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", hint: "WBNB", coingeckoId: "binancecoin" },
    { address: "0xe9e7cea3dedca5984780bafc599bd69add087d56", hint: "BUSD", coingeckoId: "binance-usd" },
    { address: "0x2170ed0880ac9a755fd29b2688956bd959f933f8", hint: "ETH", coingeckoId: "ethereum" },
    { address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c", hint: "BTCB", coingeckoId: "bitcoin" },
    { address: "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82", hint: "CAKE", coingeckoId: "pancakeswap-token" },
  ],
  1: [
    { address: "0xdac17f958d2ee523a2206206994597c13d831ec7", hint: "USDT", coingeckoId: "tether" },
    { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", hint: "USDC", coingeckoId: "usd-coin" },
    { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", hint: "WETH", coingeckoId: "ethereum" },
    { address: "0x6b175474e89094c44da98b954eedeac495271d0f", hint: "DAI", coingeckoId: "dai" },
    { address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", hint: "WBTC", coingeckoId: "wrapped-bitcoin" },
    { address: "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984", hint: "UNI", coingeckoId: "uniswap" },
    { address: "0x514910771af9ca656af840dff83e8264ecf986ca", hint: "LINK", coingeckoId: "chainlink" },
  ],
};

export function curatedTokens(chainId) {
  return CURATED_TOKENS[Number(chainId)] ?? [];
}
