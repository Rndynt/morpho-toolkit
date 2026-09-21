import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  parseAbi,
  type PublicClient,
} from 'viem';
import type { EvmChainConfig } from '../config/chains.js';
import type { Address } from '../config/registry.js';
import { v2Pairs, solidlyPairs, type RouterCandidate, type V2PairConfig, type SolidlyPairEntry, type VenueKind } from './routes.js';
import { optimalTwoLegArbitrage } from './math.js';
import { quoteExactInput, type QuoteVenue } from './quotes.js';

const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as Address;
const REQUEST_TIMEOUT_MS = 15_000;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const v2RouterAbi = parseAbi(['function factory() view returns (address)']);
const v2FactoryAbi = parseAbi(['function getPair(address,address) view returns (address)']);
const v2PairAbi = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
]);

const solidlyFactoryAbi = parseAbi(['function getPool(address,address,bool) view returns (address)']);
const solidlyPoolAbi = parseAbi([
  'function getReserves() view returns (uint256,uint256,uint256)',
  'function token0() view returns (address)',
]);
const erc20BalanceAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

type RouterReserves = {
  label: string;
  router: Address;
  pair: Address;
  reserveA: bigint;
  reserveB: bigint;
  feeBps: number;
  kind: VenueKind;
  // Only set for kind === 'aerodrome' - a V2 router has no equivalent since the router
  // address alone fully determines which pool it reaches.
  factory: Address | null;
  stable: boolean | null;
};

export type ArbOpportunity = {
  /** Immutable chain snapshot used for every reserve/factory read in this opportunity. */
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  pairLabel: string;
  loanTokenSymbol: string;
  intermediateTokenSymbol: string;
  buyOn: string;
  sellOn: string;
  loanAmountFormatted: string;
  grossProfitFormatted: string;
  estGasCostNative: number | null;
  estGasCostInLoanToken: number | null;
  netProfit: number | null;
  // Formatted fields are display-only. Use these raw amounts for all arithmetic and
  // calldata so the fixed six-decimal display precision never changes execution values.
  loanAmountRaw: bigint;
  expectedIntermediateRaw: bigint;
  expectedFinalRaw: bigint;
  grossProfitRaw: bigint;
  loanToken: Address;
  intermediateToken: Address;
  loanTokenDecimals: number;
  buyRouter: Address;
  sellRouter: Address;
  buyKind: VenueKind;
  sellKind: VenueKind;
  buyFactory: Address | null;
  sellFactory: Address | null;
  buyPool: Address;
  sellPool: Address;
  /** Actual Solidly pool type read as part of the router quote; null for V2. */
  buyAeroStable: boolean | null;
  sellAeroStable: boolean | null;
};

function numberToRaw(amount: number, decimals: number): bigint {
  // The optimizer operates on normalized JavaScript numbers. Convert its full decimal
  // representation once, rather than routing execution through the six-decimal display
  // strings below.
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return parseUnits(amount.toFixed(decimals), decimals);
}

function formatRawForDisplay(amount: bigint, decimals: number): string {
  const [whole, fraction = ''] = formatUnits(amount, decimals).split('.');
  return `${whole}.${fraction.padEnd(6, '0').slice(0, 6)}`;
}

export type SeedTokenPrice = {
  address: Address;
  priceUsd?: number | null;
  priceTimestamp?: number | null;
  priceSource?: 'morpho-api' | 'defillama' | null;
  /** Inventory metadata from discovery. The balance is informational only: the arb
   * scanner refreshes it at its own reserve snapshot before sizing a trade. */
  balance?: bigint;
  blockNumber?: bigint;
  eligible?: boolean;
};

export type MorphoInventory = Required<Pick<SeedTokenPrice, 'address' | 'balance' | 'blockNumber' | 'eligible'>>;

export type VenueTvl = {
  pairLabel: string;
  venue: string;
  tvlUsd: number | null;
  tokenPrices: Array<{
    address: Address;
    priceUsd: number | null;
    source: 'morpho-api' | 'defillama' | null;
    timestamp: number | null;
  }>;
  /** full = both reserve sides priced; partial is a doubled one-sided estimate. */
  confidence: 'full' | 'partial' | 'unpriced';
  status: 'priced' | 'unpriced';
  /** TVL pricing never promotes a venue to executable; a quote-based plan must do that separately. */
  executableCandidate: boolean;
};

export type SpotPrice = {
  pairLabel: string;
  venue: string;
  tokenAPerTokenB: number;
  deviationPct: number | null;
};

export type ArbScanResult = {
  chain: EvmChainConfig;
  blockNumber: bigint;
  blockHash: string;
  blockTimestamp: bigint;
  gasPriceWei: bigint;
  gasUnitsEstimate: number;
  opportunities: ArbOpportunity[];
  spotPrices: SpotPrice[];
  venueTvl: VenueTvl[];
  skipped: Array<{ pairLabel: string; router: string; reason: string }>;
  warnings: string[];
};

export type ArbScanOptions = {
  chain: EvmChainConfig;
  rpcUrl: string;
  gasUnitsEstimate?: number;
  onProgress?: (message: string) => void;
  // External scanner prices may only estimate/display TVL and apply the inventory-style
  // TVL filter. They MUST NOT be used for min-out, min-profit, or executable calldata.
  seedTokens?: SeedTokenPrice[];
  /** Required to enforce Morpho liquidity. balanceOf reads are pinned to the DEX snapshot. */
  morphoAddress?: Address;
  /** Raw token units. May be one global limit or limits keyed by token address. */
  configuredMaxTradeSizeRaw?: bigint | Record<string, bigint>;
  minTvlUsd?: number;
  /** Injectable for tests; production scans create a client from rpcUrl. */
  publicClient?: PublicClient;
};

export function capLoanAmount(optimal: bigint, morphoAvailable: bigint, configuredMax: bigint): bigint {
  if (optimal <= 0n || morphoAvailable <= 0n || configuredMax <= 0n) return 0n;
  return optimal < morphoAvailable
    ? (optimal < configuredMax ? optimal : configuredMax)
    : (morphoAvailable < configuredMax ? morphoAvailable : configuredMax);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n', 1)[0];
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

async function resolveRouterReserves(
  client: PublicClient,
  pairConfig: V2PairConfig,
  blockNumber: bigint,
  skipped: ArbScanResult['skipped'],
): Promise<RouterReserves[]> {
  const pairLabel = `${pairConfig.tokenA.symbol}/${pairConfig.tokenB.symbol}`;

  const factoryCalls = await client.multicall({
    blockNumber,
    allowFailure: true,
    multicallAddress: MULTICALL3,
    contracts: pairConfig.routers.map((r) => ({
      address: r.router,
      abi: v2RouterAbi,
      functionName: 'factory' as const,
    })),
  });

  const withFactory: Array<{ router: RouterCandidate; factory: Address | null }> = pairConfig.routers.map(
    (r, i) => ({
      router: r,
      factory: factoryCalls[i]?.status === 'success' ? (factoryCalls[i]!.result as Address) : null,
    }),
  );
  withFactory.forEach((entry, i) => {
    if (!entry.factory) {
      skipped.push({
        pairLabel,
        router: entry.router.label,
        reason: `factory() failed: ${errorMessage(factoryCalls[i]?.status === 'failure' ? factoryCalls[i]!.error : 'no result')}`,
      });
    }
  });

  const resolvable = withFactory.filter(
    (e): e is { router: RouterCandidate; factory: Address } => e.factory !== null,
  );
  // Used to require >= 2 V2 routers to resolve before doing anything, which silently
  // threw away a perfectly good single V2 reading (e.g. only Uniswap V2 has a pair,
  // Sushi doesn't) even though the caller can still pair it against an Aerodrome venue
  // resolved separately. >= 1 is all this function itself needs.
  if (resolvable.length < 1) return [];

  const pairCalls = await client.multicall({
    blockNumber,
    allowFailure: true,
    multicallAddress: MULTICALL3,
    contracts: resolvable.map((e) => ({
      address: e.factory,
      abi: v2FactoryAbi,
      functionName: 'getPair' as const,
      args: [pairConfig.tokenA.address, pairConfig.tokenB.address] as const,
    })),
  });

  const withPair = resolvable.map((e, i) => ({
    router: e.router,
    pair: pairCalls[i]?.status === 'success' ? (pairCalls[i]!.result as Address) : null,
  }));
  const usablePairs = withPair.filter(
    (e): e is { router: RouterCandidate; pair: Address } =>
      e.pair !== null && getAddress(e.pair) !== getAddress(ZERO_ADDRESS),
  );
  withPair.forEach((e) => {
    if (!e.pair || getAddress(e.pair) === getAddress(ZERO_ADDRESS)) {
      skipped.push({ pairLabel, router: e.router.label, reason: 'no pair for this token combination' });
    }
  });
  // Same reasoning as the factory gate above: a single resolved V2 pair is still useful
  // once combined with an Aerodrome venue by the caller, so >= 1 not >= 2.
  if (usablePairs.length < 1) return [];

  const reserveCalls = await client.multicall({
    blockNumber,
    allowFailure: true,
    multicallAddress: MULTICALL3,
    contracts: usablePairs.flatMap((e) => [
      { address: e.pair, abi: v2PairAbi, functionName: 'getReserves' as const },
      { address: e.pair, abi: v2PairAbi, functionName: 'token0' as const },
    ]),
  });

  const results: RouterReserves[] = [];
  usablePairs.forEach((entry, i) => {
    const reservesResult = reserveCalls[i * 2];
    const token0Result = reserveCalls[i * 2 + 1];
    if (reservesResult?.status !== 'success' || token0Result?.status !== 'success') {
      skipped.push({ pairLabel, router: entry.router.label, reason: 'getReserves/token0 read failed' });
      return;
    }
    const [r0, r1] = reservesResult.result as readonly [bigint, bigint, number];
    const isAToken0 = getAddress(token0Result.result as Address) === getAddress(pairConfig.tokenA.address);
    results.push({
      label: entry.router.label,
      router: entry.router.router,
      pair: entry.pair,
      reserveA: isAToken0 ? r0 : r1,
      reserveB: isAToken0 ? r1 : r0,
      feeBps: pairConfig.feeBps,
      kind: 'v2',
      factory: null,
      stable: null,
    });
  });
  return results;
}

async function resolveSolidlyReserves(
  client: PublicClient,
  entry: SolidlyPairEntry,
  blockNumber: bigint,
  skipped: ArbScanResult['skipped'],
): Promise<RouterReserves | null> {
  const pairLabel = `${entry.tokenA.symbol}/${entry.tokenB.symbol}`;
  let poolAddress: Address;
  try {
    poolAddress = (await client.readContract({
      blockNumber,
      address: entry.pool.factory,
      abi: solidlyFactoryAbi,
      functionName: 'getPool',
      args: [entry.tokenA.address, entry.tokenB.address, entry.pool.stable],
    })) as Address;
  } catch (error) {
    skipped.push({ pairLabel, router: entry.pool.label, reason: `getPool() failed: ${errorMessage(error)}` });
    return null;
  }
  if (!poolAddress || getAddress(poolAddress) === getAddress(ZERO_ADDRESS)) {
    skipped.push({ pairLabel, router: entry.pool.label, reason: 'no pool for this token combination' });
    return null;
  }

  try {
    const [reservesResult, token0Result] = await client.multicall({
      blockNumber,
      allowFailure: true,
      multicallAddress: MULTICALL3,
      contracts: [
        { address: poolAddress, abi: solidlyPoolAbi, functionName: 'getReserves' as const },
        { address: poolAddress, abi: solidlyPoolAbi, functionName: 'token0' as const },
      ],
    });
    if (reservesResult?.status !== 'success' || token0Result?.status !== 'success') {
      skipped.push({ pairLabel, router: entry.pool.label, reason: 'getReserves/token0 read failed' });
      return null;
    }
    const [r0, r1] = reservesResult.result as readonly [bigint, bigint, bigint];
    const isAToken0 = getAddress(token0Result.result as Address) === getAddress(entry.tokenA.address);
    return {
      label: entry.pool.label,
      // The Router contract, NOT the pool - MorphoAtomicArbPOCv2 calls
      // router.swapExactTokensForTokens(...), never the pool directly. poolAddress is
      // only used above/below for reading reserves.
      router: entry.pool.router,
      pair: poolAddress,
      reserveA: isAToken0 ? r0 : r1,
      reserveB: isAToken0 ? r1 : r0,
      feeBps: entry.pool.feeBps,
      kind: 'aerodrome',
      factory: entry.pool.factory,
      stable: entry.pool.stable,
    };
  } catch (error) {
    skipped.push({ pairLabel, router: entry.pool.label, reason: `read failed: ${errorMessage(error)}` });
    return null;
  }
}

/**
 * Reads live reserves for every configured router on a pair, then evaluates every
 * ordered (buyOn, sellOn) router combination in both loan-token directions using the
 * closed-form optimizer in ./math.ts. Read-only - never sends a transaction and never
 * requires a private key. Safe to run as often as you like.
 */
export async function scanArbOpportunities(options: ArbScanOptions): Promise<ArbScanResult> {
  const gasUnitsEstimate = options.gasUnitsEstimate ?? 400_000;
  const warnings: string[] = [];
  const skipped: ArbScanResult['skipped'] = [];
  const opportunities: ArbOpportunity[] = [];
  const spotPrices: SpotPrice[] = [];
  const venueTvl: VenueTvl[] = [];

  const client = options.publicClient ?? createPublicClient({
    // No transport-level batching: Multicall3 already aggregates every read into a
    // single eth_call, and stacking viem's JSON-RPC array-batching on top of that broke
    // against at least one public multi-node gateway during testing ("Invalid parameters
    // were provided to the RPC method"). Keeping this off trades a little latency for
    // much better compatibility with free/public RPC endpoints.
    transport: http(options.rpcUrl, { retryCount: 1, timeout: REQUEST_TIMEOUT_MS }),
  });

  options.onProgress?.('Connecting to RPC...');
  const actualChainId = await client.getChainId();
  if (actualChainId !== options.chain.chainId) {
    throw new Error(`RPC chainId ${actualChainId}, expected ${options.chain.chainId} (${options.chain.key})`);
  }
  // Resolve an immutable snapshot before any execution-critical reads. Every factory,
  // pool, reserve, and token-order lookup below is pinned to this exact block.
  const blockNumber = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });
  if (!block.hash) throw new Error(`block ${blockNumber} has no hash`);
  const [blockHash, blockTimestamp] = [block.hash, block.timestamp];
  const gasPriceWei = await client.getGasPrice();
  const gasCostEth = Number(formatUnits(gasPriceWei * BigInt(gasUnitsEstimate), 18));

  // Never reuse the discovery scan's balance: reserves and available flash-loan
  // inventory must describe exactly the same block.
  const morphoBalanceByAddress = new Map<string, bigint>();
  if (options.morphoAddress) {
    const addresses = [...new Set([
      ...(options.seedTokens ?? []).filter((t) => t.eligible !== false).map((t) => t.address.toLowerCase()),
      ...v2Pairs.filter((pair) => pair.chain === options.chain.key)
        .flatMap((pair) => [pair.tokenA.address.toLowerCase(), pair.tokenB.address.toLowerCase()]),
    ])];
    for (const address of addresses) {
      const balance = await client.readContract({
        address: getAddress(address) as Address, abi: erc20BalanceAbi, functionName: 'balanceOf',
        args: [options.morphoAddress], blockNumber,
      }) as bigint;
      morphoBalanceByAddress.set(address, balance);
    }
  }

  const availableLoanAmount = (address: Address): bigint => {
    if (!options.morphoAddress) return (1n << 256n) - 1n;
    const seed = (options.seedTokens ?? []).find((token) => token.address.toLowerCase() === address.toLowerCase());
    if (seed?.eligible === false) return 0n;
    return morphoBalanceByAddress.get(address.toLowerCase()) ?? 0n;
  };
  const configuredLimit = (address: Address): bigint => {
    const limit = options.configuredMaxTradeSizeRaw;
    if (typeof limit === 'bigint') return limit;
    return limit?.[address.toLowerCase()] ?? (1n << 256n) - 1n;
  };

  const pairsForChain = v2Pairs.filter((p) => p.chain === options.chain.key);
  if (pairsForChain.length === 0) {
    warnings.push(`no configured v2Pairs for chain "${options.chain.key}" - add one in tools/src/arb/routes.ts`);
  }

  // USD price lookup for the TVL filter below, built once from whatever prices the
  // caller passed in (e.g. Morpho's own asset list already carries priceUsd). A token
  // with no known price is simply never TVL-filtered (we can't estimate it), not
  // silently treated as $0 - see assessVenueTvl.
  const usdPriceByAddress = new Map<string, SeedTokenPrice>();
  for (const token of options.seedTokens ?? []) {
    if (token.priceUsd != null && token.priceUsd > 0) {
      usdPriceByAddress.set(token.address.toLowerCase(), token);
    }
  }
  function assessVenueTvl(pairLabel: string, pairConfig: V2PairConfig, r: RouterReserves): VenueTvl {
    const priceA = usdPriceByAddress.get(pairConfig.tokenA.address.toLowerCase());
    const priceB = usdPriceByAddress.get(pairConfig.tokenB.address.toLowerCase());
    const valueA = priceA ? Number(formatUnits(r.reserveA, pairConfig.tokenA.decimals)) * priceA.priceUsd! : null;
    const valueB = priceB ? Number(formatUnits(r.reserveB, pairConfig.tokenB.decimals)) * priceB.priceUsd! : null;
    // Prefer both sides when we have both (most accurate); fall back to doubling
    // whichever single side is known (assumes a roughly balanced pool, which is true
    // for constant-product AMMs away from extreme imbalance - fine for a filter
    // threshold, not precise enough for anything else).
    const tvlUsd = valueA !== null && valueB !== null ? valueA + valueB
      : valueA !== null ? valueA * 2 : valueB !== null ? valueB * 2 : null;
    const confidence = valueA !== null && valueB !== null ? 'full'
      : tvlUsd !== null ? 'partial' : 'unpriced';
    return {
      pairLabel, venue: r.label, tvlUsd,
      tokenPrices: [
        { address: pairConfig.tokenA.address, priceUsd: priceA?.priceUsd ?? null, source: priceA?.priceSource ?? null, timestamp: priceA?.priceTimestamp ?? null },
        { address: pairConfig.tokenB.address, priceUsd: priceB?.priceUsd ?? null, source: priceB?.priceSource ?? null, timestamp: priceB?.priceTimestamp ?? null },
      ],
      confidence, status: confidence === 'unpriced' ? 'unpriced' : 'priced',
      executableCandidate: false,
    };
  }

  const resolvedPairs: Array<{ pairConfig: V2PairConfig; reserves: RouterReserves[] }> = [];

  for (const pairConfig of pairsForChain) {
    const pairLabel = `${pairConfig.tokenA.symbol}/${pairConfig.tokenB.symbol}`;
    const matchingSolidly = solidlyPairs.filter(
      (s) =>
        s.chain === options.chain.key &&
        getAddress(s.tokenA.address) === getAddress(pairConfig.tokenA.address) &&
        getAddress(s.tokenB.address) === getAddress(pairConfig.tokenB.address),
    );
    options.onProgress?.(
      `Reading ${pairLabel} reserves across ${pairConfig.routers.length + matchingSolidly.length} venues...`,
    );
    const reserves = await resolveRouterReserves(client, pairConfig, blockNumber, skipped);

    for (const solidlyEntry of matchingSolidly) {
      const solidlyReserves = await resolveSolidlyReserves(client, solidlyEntry, blockNumber, skipped);
      if (solidlyReserves) reserves.push(solidlyReserves);
    }

    const tvlByVenue = new Map<RouterReserves, VenueTvl>();
    for (const reserve of reserves) {
      const assessment = assessVenueTvl(pairLabel, pairConfig, reserve);
      tvlByVenue.set(reserve, assessment);
      venueTvl.push(assessment);
    }
    if (options.minTvlUsd !== undefined) {
      for (let i = reserves.length - 1; i >= 0; i--) {
        const tvlUsd = tvlByVenue.get(reserves[i]!)!.tvlUsd;
        if (tvlUsd !== null && tvlUsd < options.minTvlUsd) {
          skipped.push({
            pairLabel,
            router: reserves[i]!.label,
            reason: `TVL ~$${tvlUsd.toFixed(0)} below minimum $${options.minTvlUsd}`,
          });
          reserves.splice(i, 1);
        }
      }
    }

    if (reserves.length < 2) {
      warnings.push(`${pairLabel}: fewer than 2 usable router quotes on ${options.chain.key}, skipping`);
      continue;
    }

    // Raw spot price per venue (tokenA per 1 tokenB, e.g. USDC per WETH) - computed
    // directly from reserves, with no fee, no optimizer, no threshold. This exists so
    // "found nothing" can be double-checked against the actual underlying price gap
    // instead of just trusted: if venues are already within roughly one fee round-trip
    // of each other, zero opportunities is the CORRECT answer, not a bug or a threshold
    // problem (min-net defaults to 0 - opportunities are pre-filtered to gross-profitable
    // before any threshold is even applied, so a high threshold can't hide anything here).
    const venuePrices = reserves.map((r) => ({
      venue: r.label,
      price:
        Number(formatUnits(r.reserveA, pairConfig.tokenA.decimals)) /
        Number(formatUnits(r.reserveB, pairConfig.tokenB.decimals)),
    }));
    const medianPrice = [...venuePrices.map((v) => v.price)].sort((a, b) => a - b)[
      Math.floor(venuePrices.length / 2)
    ]!;
    for (const vp of venuePrices) {
      spotPrices.push({
        pairLabel,
        venue: vp.venue,
        tokenAPerTokenB: vp.price,
        deviationPct: medianPrice > 0 ? ((vp.price - medianPrice) / medianPrice) * 100 : null,
      });
    }

    resolvedPairs.push({ pairConfig, reserves });
  }

  // Chain-wide "units of token per 1 WETH" reference, built from whichever already-
  // resolved pairs happen to touch WETH on either side - no extra RPC calls, no external
  // price API. This lets gas-cost conversion work for pairs that don't themselves
  // contain WETH (e.g. USDC/AERO can use the USDC/WETH and WETH/AERO pairs' own reserves)
  // as long as at least one WETH-containing pair is configured for the token in question.
  // Falls back to null (shown as "n/a" in the CLI) when no such reference exists yet.
  const ethPriceInToken = new Map<string, number>();
  const wethAddressLower = pairsForChain
    .flatMap((p) => [p.tokenA, p.tokenB])
    .find((t) => t.symbol === 'WETH')?.address.toLowerCase();
  if (wethAddressLower) ethPriceInToken.set(wethAddressLower, 1);
  for (const { pairConfig, reserves } of resolvedPairs) {
    const deepest = [...reserves].sort((a, b) => (a.reserveB < b.reserveB ? 1 : -1))[0]!;
    const tokenALower = pairConfig.tokenA.address.toLowerCase();
    const tokenBLower = pairConfig.tokenB.address.toLowerCase();
    if (pairConfig.tokenA.symbol === 'WETH' && !ethPriceInToken.has(tokenBLower) && deepest.reserveA > 0n) {
      // units of tokenB per 1 WETH(=tokenA)
      ethPriceInToken.set(
        tokenBLower,
        Number(formatUnits(deepest.reserveB, pairConfig.tokenB.decimals)) /
          Number(formatUnits(deepest.reserveA, pairConfig.tokenA.decimals)),
      );
    }
    if (pairConfig.tokenB.symbol === 'WETH' && !ethPriceInToken.has(tokenALower) && deepest.reserveB > 0n) {
      // units of tokenA per 1 WETH(=tokenB)
      ethPriceInToken.set(
        tokenALower,
        Number(formatUnits(deepest.reserveA, pairConfig.tokenA.decimals)) /
          Number(formatUnits(deepest.reserveB, pairConfig.tokenB.decimals)),
      );
    }
  }

  for (const { pairConfig, reserves } of resolvedPairs) {
    const pairLabel = `${pairConfig.tokenA.symbol}/${pairConfig.tokenB.symbol}`;
    const gasCostInTokenA = ethPriceInToken.has(pairConfig.tokenA.address.toLowerCase())
      ? gasCostEth * ethPriceInToken.get(pairConfig.tokenA.address.toLowerCase())!
      : null;
    const gasCostInTokenB = ethPriceInToken.has(pairConfig.tokenB.address.toLowerCase())
      ? gasCostEth * ethPriceInToken.get(pairConfig.tokenB.address.toLowerCase())!
      : null;

    const quoteVenue = (reserve: RouterReserves): QuoteVenue => ({
      kind: reserve.kind, label: reserve.label, router: reserve.router, factory: reserve.factory,
      pool: reserve.pair, feeBps: reserve.feeBps,
    });
    const quoteTwoLegs = async (loanAmountRaw: bigint, buyOn: RouterReserves, sellOn: RouterReserves, loanToken: Address, intermediateToken: Address) => {
      const first = await quoteExactInput(client, {
        venue: quoteVenue(buyOn), tokenIn: loanToken, tokenOut: intermediateToken, amountInRaw: loanAmountRaw, snapshotBlock: blockNumber,
      });
      const second = await quoteExactInput(client, {
        venue: quoteVenue(sellOn), tokenIn: intermediateToken, tokenOut: loanToken, amountInRaw: first.amountOutRaw, snapshotBlock: blockNumber,
      });
      return { first, second };
    };

    for (const buyOn of reserves) {
      for (const sellOn of reserves) {
        if (buyOn.router === sellOn.router) continue;

        // Direction 1: borrow tokenA, buy tokenB on buyOn, sell tokenB for tokenA on sellOn.
        const resultA = optimalTwoLegArbitrage(
          {
            reserveIn: Number(formatUnits(buyOn.reserveA, pairConfig.tokenA.decimals)),
            reserveOut: Number(formatUnits(buyOn.reserveB, pairConfig.tokenB.decimals)),
            feeBps: buyOn.feeBps,
          },
          {
            reserveIn: Number(formatUnits(sellOn.reserveB, pairConfig.tokenB.decimals)),
            reserveOut: Number(formatUnits(sellOn.reserveA, pairConfig.tokenA.decimals)),
            feeBps: sellOn.feeBps,
          },
        );
        if (resultA.profitable) {
          const loanAmountRaw = capLoanAmount(
            numberToRaw(resultA.loanAmount, pairConfig.tokenA.decimals),
            availableLoanAmount(pairConfig.tokenA.address), configuredLimit(pairConfig.tokenA.address),
          );
          if (loanAmountRaw === 0n) continue;
          let quoted;
          try {
            quoted = await quoteTwoLegs(loanAmountRaw, buyOn, sellOn, pairConfig.tokenA.address, pairConfig.tokenB.address);
          } catch (error) {
            skipped.push({ pairLabel, router: `${buyOn.label} -> ${sellOn.label}`, reason: `router quote failed: ${errorMessage(error)}` });
            continue;
          }
          const expectedIntermediateRaw = quoted.first.amountOutRaw;
          const expectedFinalRaw = quoted.second.amountOutRaw;
          const grossProfitRaw = expectedFinalRaw - loanAmountRaw;
          if (grossProfitRaw <= 0n) continue;
          opportunities.push({
            blockNumber,
            blockHash,
            blockTimestamp,
            pairLabel,
            loanTokenSymbol: pairConfig.tokenA.symbol,
            intermediateTokenSymbol: pairConfig.tokenB.symbol,
            buyOn: buyOn.label,
            sellOn: sellOn.label,
            loanAmountFormatted: formatRawForDisplay(loanAmountRaw, pairConfig.tokenA.decimals),
            grossProfitFormatted: formatRawForDisplay(grossProfitRaw, pairConfig.tokenA.decimals),
            loanAmountRaw,
            expectedIntermediateRaw,
            expectedFinalRaw,
            grossProfitRaw,
            estGasCostNative: gasCostEth,
            estGasCostInLoanToken: gasCostInTokenA,
            netProfit: gasCostInTokenA !== null ? Number(formatUnits(grossProfitRaw, pairConfig.tokenA.decimals)) - gasCostInTokenA : null,
            loanToken: pairConfig.tokenA.address,
            intermediateToken: pairConfig.tokenB.address,
            loanTokenDecimals: pairConfig.tokenA.decimals,
            buyRouter: buyOn.router,
            sellRouter: sellOn.router,
            buyKind: buyOn.kind,
            sellKind: sellOn.kind,
            buyFactory: buyOn.factory,
            sellFactory: sellOn.factory,
            buyPool: buyOn.pair,
            sellPool: sellOn.pair,
            buyAeroStable: quoted.first.poolType === 'v2' ? null : quoted.first.poolType === 'stable',
            sellAeroStable: quoted.second.poolType === 'v2' ? null : quoted.second.poolType === 'stable',
          });
        }

        // Direction 2: borrow tokenB, buy tokenA on buyOn, sell tokenA for tokenB on sellOn.
        const resultB = optimalTwoLegArbitrage(
          {
            reserveIn: Number(formatUnits(buyOn.reserveB, pairConfig.tokenB.decimals)),
            reserveOut: Number(formatUnits(buyOn.reserveA, pairConfig.tokenA.decimals)),
            feeBps: buyOn.feeBps,
          },
          {
            reserveIn: Number(formatUnits(sellOn.reserveA, pairConfig.tokenA.decimals)),
            reserveOut: Number(formatUnits(sellOn.reserveB, pairConfig.tokenB.decimals)),
            feeBps: sellOn.feeBps,
          },
        );
        if (resultB.profitable) {
          const loanAmountRaw = capLoanAmount(
            numberToRaw(resultB.loanAmount, pairConfig.tokenB.decimals),
            availableLoanAmount(pairConfig.tokenB.address), configuredLimit(pairConfig.tokenB.address),
          );
          if (loanAmountRaw === 0n) continue;
          let quoted;
          try {
            quoted = await quoteTwoLegs(loanAmountRaw, buyOn, sellOn, pairConfig.tokenB.address, pairConfig.tokenA.address);
          } catch (error) {
            skipped.push({ pairLabel, router: `${buyOn.label} -> ${sellOn.label}`, reason: `router quote failed: ${errorMessage(error)}` });
            continue;
          }
          const expectedIntermediateRaw = quoted.first.amountOutRaw;
          const expectedFinalRaw = quoted.second.amountOutRaw;
          const grossProfitRaw = expectedFinalRaw - loanAmountRaw;
          if (grossProfitRaw <= 0n) continue;
          opportunities.push({
            blockNumber,
            blockHash,
            blockTimestamp,
            pairLabel,
            loanTokenSymbol: pairConfig.tokenB.symbol,
            intermediateTokenSymbol: pairConfig.tokenA.symbol,
            buyOn: buyOn.label,
            sellOn: sellOn.label,
            loanAmountFormatted: formatRawForDisplay(loanAmountRaw, pairConfig.tokenB.decimals),
            grossProfitFormatted: formatRawForDisplay(grossProfitRaw, pairConfig.tokenB.decimals),
            loanAmountRaw,
            expectedIntermediateRaw,
            expectedFinalRaw,
            grossProfitRaw,
            estGasCostNative: gasCostEth,
            estGasCostInLoanToken: gasCostInTokenB,
            netProfit: gasCostInTokenB !== null ? Number(formatUnits(grossProfitRaw, pairConfig.tokenB.decimals)) - gasCostInTokenB : null,
            loanToken: pairConfig.tokenB.address,
            intermediateToken: pairConfig.tokenA.address,
            loanTokenDecimals: pairConfig.tokenB.decimals,
            buyRouter: buyOn.router,
            sellRouter: sellOn.router,
            buyKind: buyOn.kind,
            sellKind: sellOn.kind,
            buyFactory: buyOn.factory,
            sellFactory: sellOn.factory,
            buyPool: buyOn.pair,
            sellPool: sellOn.pair,
            buyAeroStable: quoted.first.poolType === 'v2' ? null : quoted.first.poolType === 'stable',
            sellAeroStable: quoted.second.poolType === 'v2' ? null : quoted.second.poolType === 'stable',
          });
        }
      }
    }
  }

  // Rank by net profit (after estimated gas) when we could compute it, otherwise fall
  // back to gross profit - keeps unranked (no gas-price-reference) results visible
  // instead of dropping them, while still favoring results we're more confident in.
  const rank = (o: ArbOpportunity): number => o.netProfit ?? Number(formatUnits(o.grossProfitRaw, o.loanTokenDecimals));
  opportunities.sort((a, b) => rank(b) - rank(a));

  return {
    chain: options.chain,
    blockNumber,
    blockHash,
    blockTimestamp,
    gasPriceWei,
    gasUnitsEstimate,
    opportunities,
    spotPrices,
    venueTvl,
    skipped,
    warnings,
  };
}
