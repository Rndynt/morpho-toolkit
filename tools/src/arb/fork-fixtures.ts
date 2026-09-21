import type { VenueKind } from './routes.js';

/** Immutable fork anchors. Update deliberately: changing a block changes the test corpus. */
export type ForkFixture = {
  chain: 'base' | 'robinhood';
  chainId: number;
  venue: string;
  kind: VenueKind;
  blockNumber: bigint;
  reason: string;
};

export const forkFixtures: readonly ForkFixture[] = [
  { chain: 'base', chainId: 8453, venue: 'Uniswap V2', kind: 'v2', blockNumber: 36_500_000n, reason: 'post-deployment block with an active USDC/WETH pool and reproducible archive state' },
  { chain: 'base', chainId: 8453, venue: 'Sushi V2', kind: 'v2', blockNumber: 36_500_000n, reason: 'same-block cross-venue comparison against Uniswap V2' },
  { chain: 'base', chainId: 8453, venue: 'Aerodrome (volatile)', kind: 'aerodrome', blockNumber: 36_500_000n, reason: 'liquid volatile pool exists at the shared Base comparison block' },
  { chain: 'base', chainId: 8453, venue: 'Aerodrome (stable)', kind: 'aerodrome', blockNumber: 36_500_000n, reason: 'stable curve is deployed and queryable at the shared Base comparison block' },
  { chain: 'robinhood', chainId: 4663, venue: 'Uniswap V2', kind: 'v2', blockNumber: 51_530_828n, reason: 'known successful Morpho loan block with deployed router and token liquidity' },
] as const;

