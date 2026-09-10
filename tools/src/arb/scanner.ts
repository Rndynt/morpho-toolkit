import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseAbi,
  type PublicClient,
} from 'viem';
import type { EvmChainConfig } from '../config/chains.js';
import type { Address } from '../config/registry.js';
import { v2Pairs, solidlyPairs, type RouterCandidate, type V2PairConfig, type SolidlyPairEntry } from './routes.js';
import { optimalTwoLegArbitrage } from './math.js';

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

type RouterReserves = {
  label: string;
  router: Address;
  pair: Address;
  reserveA: bigint;
  reserveB: bigint;
  feeBps: number;
};

export type ArbOpportunity = {
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
};

export type ArbScanResult = {
  chain: EvmChainConfig;
  blockNumber: bigint;
  gasPriceWei: bigint;
  gasUnitsEstimate: number;
  opportunities: ArbOpportunity[];
  skipped: Array<{ pairLabel: string; router: string; reason: string }>;
  warnings: string[];
};

export type ArbScanOptions = {
  chain: EvmChainConfig;
  rpcUrl: string;
  gasUnitsEstimate?: number;
  onProgress?: (message: string) => void;
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split('\n', 1)[0];
  return firstLine.length > 240 ? `${firstLine.slice(0, 237)}...` : firstLine;
}

async function resolveRouterReserves(
  client: PublicClient,
  pairConfig: V2PairConfig,
  skipped: ArbScanResult['skipped'],
): Promise<RouterReserves[]> {
  const pairLabel = `${pairConfig.tokenA.symbol}/${pairConfig.tokenB.symbol}`;

  const factoryCalls = await client.multicall({
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
  if (resolvable.length < 2) return [];

  const pairCalls = await client.multicall({
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
  if (usablePairs.length < 2) return [];

  const reserveCalls = await client.multicall({
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
    });
  });
  return results;
}

async function resolveSolidlyReserves(
  client: PublicClient,
  entry: SolidlyPairEntry,
  skipped: ArbScanResult['skipped'],
): Promise<RouterReserves | null> {
  const pairLabel = `${entry.tokenA.symbol}/${entry.tokenB.symbol}`;
  let poolAddress: Address;
  try {
    poolAddress = (await client.readContract({
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
      router: poolAddress,
      pair: poolAddress,
      reserveA: isAToken0 ? r0 : r1,
      reserveB: isAToken0 ? r1 : r0,
      feeBps: entry.pool.feeBps,
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

  const client = createPublicClient({
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
  // Fetched once for display/reporting only - reads below intentionally do NOT pin to
  // this exact block (see the transport comment above for why).
  const [blockNumber, gasPriceWei] = await Promise.all([client.getBlockNumber(), client.getGasPrice()]);
  const gasCostEth = Number(formatUnits(gasPriceWei * BigInt(gasUnitsEstimate), 18));

  const pairsForChain = v2Pairs.filter((p) => p.chain === options.chain.key);
  if (pairsForChain.length === 0) {
    warnings.push(`no configured v2Pairs for chain "${options.chain.key}" - add one in tools/src/arb/routes.ts`);
  }

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
    const reserves = await resolveRouterReserves(client, pairConfig, skipped);

    for (const solidlyEntry of matchingSolidly) {
      const solidlyReserves = await resolveSolidlyReserves(client, solidlyEntry, skipped);
      if (solidlyReserves) reserves.push(solidlyReserves);
    }

    if (reserves.length < 2) {
      warnings.push(`${pairLabel}: fewer than 2 usable router quotes on ${options.chain.key}, skipping`);
      continue;
    }

    // Reference price for converting gas cost into loan-token terms, derived from the
    // deepest pool's own reserves - no external price API, self-consistent with what we
    // just read on-chain. Only meaningful when tokenB is the chain's wrapped-native asset.
    const deepest = [...reserves].sort((a, b) => (a.reserveB < b.reserveB ? 1 : -1))[0]!;
    const nativePriceInTokenA =
      pairConfig.tokenB.symbol === 'WETH' && deepest.reserveB > 0n
        ? Number(formatUnits(deepest.reserveA, pairConfig.tokenA.decimals)) /
          Number(formatUnits(deepest.reserveB, pairConfig.tokenB.decimals))
        : null;

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
          const gasCostInTokenA = nativePriceInTokenA !== null ? gasCostEth * nativePriceInTokenA : null;
          opportunities.push({
            pairLabel,
            loanTokenSymbol: pairConfig.tokenA.symbol,
            intermediateTokenSymbol: pairConfig.tokenB.symbol,
            buyOn: buyOn.label,
            sellOn: sellOn.label,
            loanAmountFormatted: resultA.loanAmount.toFixed(6),
            grossProfitFormatted: resultA.grossProfit.toFixed(6),
            estGasCostNative: gasCostEth,
            estGasCostInLoanToken: gasCostInTokenA,
            netProfit: gasCostInTokenA !== null ? resultA.grossProfit - gasCostInTokenA : null,
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
          // tokenB is WETH for every pair configured today, so gas (already in ETH) is
          // directly comparable without a price conversion.
          const gasCostInTokenB = pairConfig.tokenB.symbol === 'WETH' ? gasCostEth : null;
          opportunities.push({
            pairLabel,
            loanTokenSymbol: pairConfig.tokenB.symbol,
            intermediateTokenSymbol: pairConfig.tokenA.symbol,
            buyOn: buyOn.label,
            sellOn: sellOn.label,
            loanAmountFormatted: resultB.loanAmount.toFixed(6),
            grossProfitFormatted: resultB.grossProfit.toFixed(6),
            estGasCostNative: gasCostEth,
            estGasCostInLoanToken: gasCostInTokenB,
            netProfit: gasCostInTokenB !== null ? resultB.grossProfit - gasCostInTokenB : null,
          });
        }
      }
    }
  }

  // Rank by net profit (after estimated gas) when we could compute it, otherwise fall
  // back to gross profit - keeps unranked (no gas-price-reference) results visible
  // instead of dropping them, while still favoring results we're more confident in.
  const rank = (o: ArbOpportunity): number => o.netProfit ?? Number(o.grossProfitFormatted);
  opportunities.sort((a, b) => rank(b) - rank(a));

  return { chain: options.chain, blockNumber, gasPriceWei, gasUnitsEstimate, opportunities, skipped, warnings };
}
