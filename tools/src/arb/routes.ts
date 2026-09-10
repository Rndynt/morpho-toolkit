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

// Aerodrome is Base's largest DEX by liquidity (Solidly/Velodrome-fork) - a much more
// likely source of genuine price discovery than the neglected V2 forks above. Read
// access only needs the PoolFactory + pool contracts, not the Router (no swaps are sent
// by this scanner). Factory address corroborated as Aerodrome's on-chain identifier via
// third-party indexers; VERIFY ON BASESCAN before trusting - same caveat as the V2
// routers above, and resolveAerodromeReserves() in scanner.ts checks getPool() resolves
// to a real, non-zero pool before anything downstream trusts it.
export const solidlyPairs: SolidlyPairEntry[] = [
  {
    chain: 'base',
    tokenA: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    tokenB: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    pool: {
      chain: 'base',
      label: 'Aerodrome (volatile)',
      factory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      stable: false,
      feeBps: 30,
    },
  },
];
// Seeded only with routes that have been verified against real on-chain state (see
// evm/test/MorphoAtomicArbPOCBaseFork.t.sol - same Base addresses, same fork run that
// found a real Uniswap V2 <-> Sushi V2 WETH/USDC imbalance and captured profit from it).
// Add more pairs/routers here as they get verified; an unverified entry will simply
// return no pair (getPair reverts to address(0)) and get skipped with a warning.
export const v2Pairs: V2PairConfig[] = [
  {
    chain: 'base',
    tokenA: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    tokenB: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    routers: [
      { label: 'Uniswap V2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
      { label: 'Sushi V2', router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891' },
    ],
    feeBps: 30,
  },
];
