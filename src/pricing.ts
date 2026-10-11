/**
 * Server-side USD valuation.
 *
 * Volume has to be priced here, never by the client: a browser-reported dollar
 * value is trivially inflated, and until now it was not even being sent, so every
 * swap was recorded as $0.
 *
 * Price sources, in order of preference:
 *   1. Chainlink feeds (ETH, BTC, USDC, DAI) — verified live on Base
 *   2. $1 for known stablecoins when their feed is unavailable
 *   3. Uniswap v4 quoter, pricing the token into USDC
 *
 * Anything that cannot be priced returns undefined, and the swap is stored with
 * a zero value rather than a guess.
 */

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "./config.js";
import type { SupportedChainId } from "./verify.js";

const CHAINS = { 8453: base, 84532: baseSepolia } as const;

const aggregatorAbi = [
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

const quoterAbi = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          {
            name: "poolKey",
            type: "tuple",
            components: [
              { name: "currency0", type: "address" },
              { name: "currency1", type: "address" },
              { name: "fee", type: "uint24" },
              { name: "tickSpacing", type: "int24" },
              { name: "hooks", type: "address" },
            ],
          },
          { name: "zeroForOne", type: "bool" },
          { name: "exactAmount", type: "uint128" },
          { name: "hookData", type: "bytes" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/**
 * Chainlink feeds, verified on-chain (correct `description`, live answers).
 * Base Sepolia only publishes ETH/USD; testnet stables fall through to $1.
 */
const FEEDS: Record<SupportedChainId, Record<string, Address>> = {
  8453: {
    ETH: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    BTC: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
    USDC: "0x7e860098F58bBFC8648a4311b374B1D669a2bc6B",
    DAI: "0x591e79239a7d679378eC8c847e5038150364C78F",
  },
  84532: {
    ETH: "0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1",
  },
};

/** Which feed, if any, prices a given token symbol. */
const SYMBOL_TO_FEED: Record<string, string> = {
  ETH: "ETH",
  WETH: "ETH",
  CBETH: "ETH",
  WSTETH: "ETH",
  CBBTC: "BTC",
  WBTC: "BTC",
  USDC: "USDC",
  USDBC: "USDC",
  DAI: "DAI",
};

const STABLES = new Set(["USDC", "USDBC", "DAI", "USDT"]);

/** USDC per chain, used as the quote asset for unknown tokens. */
const USDC: Record<SupportedChainId, { address: Address; decimals: number }> = {
  8453: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", decimals: 6 },
  84532: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 },
};

const QUOTER: Record<SupportedChainId, Address> = {
  8453: "0x0d5e0F971ED27FBfF6c2837bf31316121532048D",
  84532: "0x4A6513c898fe1B2d0E78d3b0e0A4a151589B1cBa",
};

const FEE_TIERS = [
  { fee: 100, tickSpacing: 1 },
  { fee: 500, tickSpacing: 10 },
  { fee: 3000, tickSpacing: 60 },
  { fee: 10000, tickSpacing: 200 },
];

/**
 * Staleness limits.
 *
 * Volatile feeds have a short heartbeat, so an old answer means something is
 * wrong and should not be trusted. Stablecoin feeds legitimately sit untouched
 * for many hours because they only publish on deviation — measured ~19h on Base —
 * so applying the volatile limit to them would reject perfectly good prices.
 */
const MAX_AGE_VOLATILE_SECONDS = 6 * 60 * 60;
const MAX_AGE_STABLE_SECONDS = 7 * 24 * 60 * 60;

const CACHE_TTL_MS = 60_000;

interface CachedPrice {
  value: number;
  expiresAt: number;
}

const priceCache = new Map<string, CachedPrice>();
const clients = new Map<number, PublicClient>();

function clientFor(chainId: SupportedChainId, config: Config): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;
  const client = createPublicClient({
    chain: CHAINS[chainId],
    transport: http(config.rpcUrls[chainId], { retryCount: 2, timeout: 15_000 }),
  }) as PublicClient;
  clients.set(chainId, client);
  return client;
}

async function readFeed(
  chainId: SupportedChainId,
  config: Config,
  feedKey: string,
): Promise<number | undefined> {
  const address = FEEDS[chainId]?.[feedKey];
  if (!address) return undefined;

  const cacheKey = `${chainId}:feed:${feedKey}`;
  const hit = priceCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  try {
    const client = clientFor(chainId, config);
    const [decimalsResult, roundResult] = await client.multicall({
      contracts: [
        { address, abi: aggregatorAbi, functionName: "decimals" },
        { address, abi: aggregatorAbi, functionName: "latestRoundData" },
      ],
      allowFailure: true,
    });

    if (decimalsResult.status !== "success" || roundResult.status !== "success") {
      return undefined;
    }

    const decimals = Number(decimalsResult.result);
    const round = roundResult.result as readonly [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const answer = round[1];
    const updatedAt = Number(round[3]);

    if (answer <= 0n) return undefined;

    const ageSeconds = Math.floor(Date.now() / 1000) - updatedAt;
    const limit = STABLES.has(feedKey)
      ? MAX_AGE_STABLE_SECONDS
      : MAX_AGE_VOLATILE_SECONDS;

    if (ageSeconds > limit) {
      console.warn(
        `[pricing] ${feedKey} feed on ${chainId} is ${Math.round(ageSeconds / 3600)}h stale; ignoring`,
      );
      return undefined;
    }

    const value = Number(answer) / 10 ** decimals;
    if (!Number.isFinite(value) || value <= 0) return undefined;

    priceCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    console.warn(`[pricing] feed read failed (${feedKey}/${chainId})`, error);
    return undefined;
  }
}

function sortCurrencies(a: Address, b: Address): [Address, Address] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

/**
 * Prices an unknown token by quoting one whole unit of it into USDC through the
 * v4 quoter, probing the canonical fee tiers and taking the best result.
 */
async function quoteTokenInUsdc(
  chainId: SupportedChainId,
  config: Config,
  token: Address,
  decimals: number,
): Promise<number | undefined> {
  const usdc = USDC[chainId];
  if (!usdc || token.toLowerCase() === usdc.address.toLowerCase()) return 1;

  const cacheKey = `${chainId}:quote:${token.toLowerCase()}`;
  const hit = priceCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  // One unit, capped so an 18-decimal token does not overflow uint128 paths.
  const oneUnit = 10n ** BigInt(Math.min(decimals, 24));

  try {
    const client = clientFor(chainId, config);
    const contracts = FEE_TIERS.map(({ fee, tickSpacing }) => {
      const [currency0, currency1] = sortCurrencies(token, usdc.address);
      return {
        address: QUOTER[chainId],
        abi: quoterAbi,
        functionName: "quoteExactInputSingle" as const,
        args: [
          {
            poolKey: { currency0, currency1, fee, tickSpacing, hooks: ZERO },
            zeroForOne: token.toLowerCase() === currency0.toLowerCase(),
            exactAmount: oneUnit,
            hookData: "0x" as const,
          },
        ] as const,
      };
    });

    const results = await client.multicall({ contracts, allowFailure: true });

    let best = 0n;
    for (const result of results) {
      if (result.status !== "success") continue;
      const [amountOut] = result.result as readonly [bigint, bigint];
      if (amountOut > best) best = amountOut;
    }
    if (best === 0n) return undefined;

    const value = Number(best) / 10 ** usdc.decimals;
    if (!Number.isFinite(value) || value <= 0) return undefined;

    priceCache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    return undefined;
  }
}

/**
 * USD price of one whole token.
 *
 * `symbol` is a hint only — it selects a Chainlink feed but is never trusted for
 * the value itself, and an unrecognised symbol simply falls through to the
 * on-chain quote.
 */
export async function getTokenPriceUsd(params: {
  config: Config;
  chainId: SupportedChainId;
  address: string;
  symbol: string;
  decimals: number;
}): Promise<number | undefined> {
  const { config, chainId, address, symbol, decimals } = params;
  const upper = symbol.toUpperCase();

  const feedKey = SYMBOL_TO_FEED[upper];
  if (feedKey) {
    const price = await readFeed(chainId, config, feedKey);
    if (price !== undefined) return price;
  }

  // A stablecoin whose feed is missing (all of testnet) is worth ~$1; that is a
  // far better estimate than dropping the swap's value to zero.
  if (STABLES.has(upper)) return 1;

  if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) return undefined;

  return quoteTokenInUsdc(
    chainId,
    config,
    address as Address,
    Number.isFinite(decimals) ? decimals : 18,
  );
}

export interface ValuationInput {
  config: Config;
  chainId: SupportedChainId;
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenInAddress: string;
  tokenOutAddress: string;
  /** Human-readable decimal strings. */
  amountIn: string;
  amountOut: string;
  decimalsIn?: number;
  decimalsOut?: number;
}

export interface Valuation {
  valueUsd: number;
  /** Which side produced the number, for logging and debugging. */
  source: "input" | "output" | "none";
}

/**
 * Values a swap in USD.
 *
 * Prefers whichever side can be priced most reliably: a stablecoin leg is exact,
 * a Chainlink-backed asset is next best, and a quoted token is last. Both legs of
 * a swap are the same value by definition, so one confident side is enough.
 */
export async function valueSwapUsd(input: ValuationInput): Promise<Valuation> {
  const amountIn = Number(input.amountIn);
  const amountOut = Number(input.amountOut);

  const candidates: {
    side: "input" | "output";
    amount: number;
    symbol: string;
    address: string;
    decimals: number;
    rank: number;
  }[] = [];

  const rank = (symbol: string) => {
    const upper = symbol.toUpperCase();
    if (STABLES.has(upper)) return 0;
    if (SYMBOL_TO_FEED[upper]) return 1;
    return 2;
  };

  if (Number.isFinite(amountIn) && amountIn > 0) {
    candidates.push({
      side: "input",
      amount: amountIn,
      symbol: input.tokenInSymbol,
      address: input.tokenInAddress,
      decimals: input.decimalsIn ?? 18,
      rank: rank(input.tokenInSymbol),
    });
  }
  if (Number.isFinite(amountOut) && amountOut > 0) {
    candidates.push({
      side: "output",
      amount: amountOut,
      symbol: input.tokenOutSymbol,
      address: input.tokenOutAddress,
      decimals: input.decimalsOut ?? 18,
      rank: rank(input.tokenOutSymbol),
    });
  }

  candidates.sort((a, b) => a.rank - b.rank);

  for (const candidate of candidates) {
    const price = await getTokenPriceUsd({
      config: input.config,
      chainId: input.chainId,
      address: candidate.address,
      symbol: candidate.symbol,
      decimals: candidate.decimals,
    });
    if (price === undefined) continue;

    const value = candidate.amount * price;
    if (Number.isFinite(value) && value >= 0) {
      return { valueUsd: value, source: candidate.side };
    }
  }

  return { valueUsd: 0, source: "none" };
}
