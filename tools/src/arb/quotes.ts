import { parseAbi, type PublicClient } from 'viem';
import type { Address } from '../config/registry.js';
import type { VenueKind } from './routes.js';

const v2RouterAbi = parseAbi(['function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)']);
const solidlyRouterAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
]);
const solidlyPoolAbi = parseAbi([
  'function stable() view returns (bool)',
  'function fee() view returns (uint256)',
]);

/** Everything needed to reproduce the exact router quote for one swap leg. */
export type QuoteVenue = {
  kind: VenueKind;
  label: string;
  router: Address;
  factory: Address | null;
  pool: Address | null;
  /** Configured V2 fee, used only as metadata because getAmountsOut is authoritative. */
  feeBps: number;
};

export type RawQuote = {
  amountInRaw: bigint;
  amountOutRaw: bigint;
  venue: QuoteVenue;
  /** V2 is constant-product; Solidly is read from the pool at the quote block. */
  poolType: 'v2' | 'volatile' | 'stable';
  /** The fee returned by a Solidly pool, or configured V2 fee metadata. */
  feeBps: bigint;
  snapshotBlock: bigint;
};

/**
 * Quotes a single-hop exact-input route at an immutable block. Router output, rather
 * than local reserve arithmetic, is the execution source of truth.
 */
export async function quoteExactInput(
  client: PublicClient,
  input: { venue: QuoteVenue; tokenIn: Address; tokenOut: Address; amountInRaw: bigint; snapshotBlock: bigint },
): Promise<RawQuote> {
  const { venue, tokenIn, tokenOut, amountInRaw, snapshotBlock } = input;
  if (amountInRaw <= 0n) throw new Error('amountInRaw must be positive');

  if (venue.kind === 'v2') {
    const amounts = await client.readContract({
      blockNumber: snapshotBlock, address: venue.router, abi: v2RouterAbi,
      functionName: 'getAmountsOut', args: [amountInRaw, [tokenIn, tokenOut]],
    }) as readonly bigint[];
    const amountOutRaw = amounts.at(-1);
    if (amountOutRaw === undefined || amountOutRaw <= 0n) throw new Error('V2 router returned no output amount');
    return { amountInRaw, amountOutRaw, venue, poolType: 'v2', feeBps: BigInt(venue.feeBps), snapshotBlock };
  }

  if (!venue.pool || !venue.factory) throw new Error('Solidly quote requires pool and factory');
  const [stable, fee] = await Promise.all([
    client.readContract({ blockNumber: snapshotBlock, address: venue.pool, abi: solidlyPoolAbi, functionName: 'stable' }),
    client.readContract({ blockNumber: snapshotBlock, address: venue.pool, abi: solidlyPoolAbi, functionName: 'fee' }),
  ]) as [boolean, bigint];
  const amounts = await client.readContract({
    blockNumber: snapshotBlock, address: venue.router, abi: solidlyRouterAbi,
    functionName: 'getAmountsOut', args: [amountInRaw, [{ from: tokenIn, to: tokenOut, stable, factory: venue.factory }]],
  }) as readonly bigint[];
  const amountOutRaw = amounts.at(-1);
  if (amountOutRaw === undefined || amountOutRaw <= 0n) throw new Error('Solidly router returned no output amount');
  return { amountInRaw, amountOutRaw, venue, poolType: stable ? 'stable' : 'volatile', feeBps: fee, snapshotBlock };
}
