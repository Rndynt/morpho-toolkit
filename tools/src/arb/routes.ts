import type { Address } from '../config/registry.js';

export type RouterCandidate = {
  label: string;
  router: Address;
};

export type V2PairConfig = {
  chain: string;
  tokenA: { symbol: string; address: Address; decimals: number };
  tokenB: { symbol: string; address: Address; decimals: number };
  routers: RouterCandidate[];
  feeBps: number;
};

export type SolidlyPoolConfig = {
  chain: string;
  label: string;
  factory: Address;
  stable: boolean;
  // Best-effort default. Solidly-fork fees (Aerodrome included) are governance-set per
  // pool and can change; this is only used to estimate profit for ranking, not for
  // building a real transaction - re-read the real fee on-chain before executing.
  feeBps: number;
};

export type SolidlyPairEntry = {
  chain: string;
  tokenA: { symbol: string; address: Address; decimals: number };
  tokenB: { symbol: string; address: Address; decimals: number };
  pool: SolidlyPoolConfig;
};

// --- Base tokens ---------------------------------------------------------------
// USDC/WETH verified against real on-chain state via evm/test/MorphoAtomicArbPOCBaseFork.t.sol.
// cbBTC/AERO addresses cross-checked via web search AND independently confirmed by this
// repo's own `npm run cli -- scan --chain base` output (Morpho API-sourced asset list) -
// two independent sources agreeing is about as confident as this sandbox can get without
// live RPC access of its own. Still, an unverified/wrong entry only ever produces a clean
// skip with a reason (getPair/getPool returning nothing) - it cannot corrupt other pairs.
const BASE_USDC = { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } as const;
const BASE_WETH = { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 } as const;
const BASE_CBBTC = { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 } as const;
const BASE_AERO = { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 } as const;

const BASE_V2_ROUTERS: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
  { label: 'Sushi V2', router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891' },
];
const BASE_AERODROME_FACTORY: Address = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';

const BASE_PAIRS: Array<[typeof BASE_USDC | typeof BASE_WETH, typeof BASE_WETH | typeof BASE_CBBTC | typeof BASE_AERO]> = [
  [BASE_USDC, BASE_WETH],
  [BASE_USDC, BASE_CBBTC],
  [BASE_WETH, BASE_CBBTC],
  [BASE_USDC, BASE_AERO],
  [BASE_WETH, BASE_AERO],
];

// Seeded only with routes reachable from tokens/venues that have been verified against
// real on-chain state (see the comment above). Add more pairs by pushing to BASE_PAIRS or
// a new per-chain array below - an unverified/wrong entry just gets skipped with a
// reason in the SKIPPED ROUTERS table, it never breaks other pairs.
export const v2Pairs: V2PairConfig[] = BASE_PAIRS.map(([tokenA, tokenB]) => ({
  chain: 'base',
  tokenA,
  tokenB,
  routers: BASE_V2_ROUTERS,
  feeBps: 30,
}));

// Aerodrome is Base's largest DEX by liquidity (Solidly/Velodrome-fork) - a much more
// likely source of genuine price discovery than the neglected V2 forks above. Read
// access only needs the PoolFactory + pool contracts, not the Router (no swaps are sent
// by this scanner). All "volatile" (constant-product) pools - "stable" pools use a
// different curve that math.ts does NOT model correctly, so stable-asset pairs (e.g.
// USDC/DAI) must not be added here until that math exists separately.
export const solidlyPairs: SolidlyPairEntry[] = BASE_PAIRS.map(([tokenA, tokenB]) => ({
  chain: 'base',
  tokenA,
  tokenB,
  pool: {
    chain: 'base',
    label: 'Aerodrome (volatile)',
    factory: BASE_AERODROME_FACTORY,
    stable: false,
    feeBps: 30,
  },
}));
