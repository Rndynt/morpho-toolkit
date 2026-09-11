import { getAddress } from 'viem';
import type { Address } from '../config/registry.js';
import {
  BASE_AERODROME_FACTORY,
  BASE_AERODROME_ROUTER,
  type SolidlyPairEntry,
  type V2PairConfig,
  type RouterCandidate,
} from './routes.js';

export type SeedToken = {
  symbol: string;
  address: Address;
  decimals: number;
  priceUsd?: number | null;
};

const BASE_QUOTES: SeedToken[] = [
  { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
];

const RH_QUOTES: SeedToken[] = [
  { symbol: 'USDG', address: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', decimals: 6 },
  { symbol: 'WETH', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 },
];

const BASE_V2: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24' },
  { label: 'Sushi V2', router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891' },
];

const RH_V2: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba' },
  { label: 'Froth legacy V2', router: '0xE454aD44efe310Fc893d919C2b1C0ea06893Efb6' },
];

function keyOf(a: Address, b: Address): string {
  const left = getAddress(a);
  const right = getAddress(b);
  return left.toLowerCase() < right.toLowerCase() ? `${left}:${right}` : `${right}:${left}`;
}

export function quotesFor(chain: string): SeedToken[] {
  if (chain === 'base') return BASE_QUOTES;
  if (chain === 'robinhood') return RH_QUOTES;
  return [];
}

export function expandPairs(
  chain: string,
  seeds: SeedToken[],
  existing: V2PairConfig[],
): { v2: V2PairConfig[]; solidly: SolidlyPairEntry[] } {
  const quotes = quotesFor(chain);
  const routers = chain === 'base' ? BASE_V2 : chain === 'robinhood' ? RH_V2 : [];
  const seen = new Set(existing.filter((p) => p.chain === chain).map((p) => keyOf(p.tokenA.address, p.tokenB.address)));
  const v2: V2PairConfig[] = [];
  const solidly: SolidlyPairEntry[] = [];
  if (!quotes.length || !routers.length) return { v2, solidly };

  const tokens = new Map<string, SeedToken>();
  for (const token of [...quotes, ...seeds]) {
    tokens.set(getAddress(token.address).toLowerCase(), {
      ...token,
      address: getAddress(token.address) as Address,
    });
  }

  for (const quote of quotes) {
    for (const token of tokens.values()) {
      if (getAddress(quote.address) === getAddress(token.address)) continue;
      const dedupe = keyOf(quote.address, token.address);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const pair: V2PairConfig = {
        chain,
        tokenA: { symbol: quote.symbol, address: quote.address, decimals: quote.decimals },
        tokenB: { symbol: token.symbol, address: token.address, decimals: token.decimals },
        routers,
        feeBps: 30,
      };
      v2.push(pair);
      if (chain === 'base') {
        solidly.push({
          chain,
          tokenA: pair.tokenA,
          tokenB: pair.tokenB,
          pool: {
            chain,
            label: 'Aerodrome (volatile)',
            router: BASE_AERODROME_ROUTER,
            factory: BASE_AERODROME_FACTORY,
            stable: false,
            feeBps: 30,
          },
        });
      }
    }
  }
  return { v2, solidly };
}
