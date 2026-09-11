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
  // The Router contract - what MorphoAtomicArbPOCv2 actually calls for execution.
  router: Address;
  // The PoolFactory - used both to read reserves (getPool) and as the on-chain guard
  // the contract checks (allowedAerodromeFactory). Distinct from router: the contract
  // calls router.swapExactTokensForTokens(...), never the pool or factory directly.
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

export type VenueKind = 'v2' | 'aerodrome';

const BASE_USDC = { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 } as const;
const BASE_WETH = { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 } as const;
const BASE_CBBTC = { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 } as const;
const BASE_AERO = { symbol: 'AERO', address: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', decimals: 18 } as const;

const BASE_V2_ROUTERS: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
  { label: 'Sushi V2', router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891' },
];
export const BASE_AERODROME_FACTORY: Address = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
export const BASE_AERODROME_ROUTER: Address = '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43';

const BASE_PAIRS: Array<[typeof BASE_USDC | typeof BASE_WETH, typeof BASE_WETH | typeof BASE_CBBTC | typeof BASE_AERO]> = [
  [BASE_USDC, BASE_WETH],
  [BASE_USDC, BASE_CBBTC],
  [BASE_WETH, BASE_CBBTC],
  [BASE_USDC, BASE_AERO],
  [BASE_WETH, BASE_AERO],
];

export const v2Pairs: V2PairConfig[] = BASE_PAIRS.map(([tokenA, tokenB]) => ({
  chain: 'base',
  tokenA,
  tokenB,
  routers: BASE_V2_ROUTERS,
  feeBps: 30,
}));

export const solidlyPairs: SolidlyPairEntry[] = BASE_PAIRS.map(([tokenA, tokenB]) => ({
  chain: 'base',
  tokenA,
  tokenB,
  pool: {
    chain: 'base',
    label: 'Aerodrome (volatile)',
    router: BASE_AERODROME_ROUTER,
    factory: BASE_AERODROME_FACTORY,
    stable: false,
    feeBps: 30,
  },
}));

const RH_USDG = { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 } as const;
const RH_WETH = { symbol: 'WETH', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 } as const;
const RH_USDE = { symbol: 'USDe', address: '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', decimals: 18 } as const;

const RH_V2_ROUTERS: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba' },
  { label: 'Froth legacy V2', router: '0xE454aD44efe310Fc893d919C2b1C0ea06893Efb6' },
];

const RH_PAIRS: Array<[typeof RH_USDG | typeof RH_WETH, typeof RH_WETH | typeof RH_USDE]> = [
  [RH_USDG, RH_WETH],
  [RH_USDG, RH_USDE],
  [RH_WETH, RH_USDE],
];

for (const [tokenA, tokenB] of RH_PAIRS) {
  v2Pairs.push({
    chain: 'robinhood',
    tokenA,
    tokenB,
    routers: RH_V2_ROUTERS,
    feeBps: 30,
  });
}
