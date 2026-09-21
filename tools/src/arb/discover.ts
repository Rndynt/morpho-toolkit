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
  { symbol: 'WETH', address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73', decimals: 18 },
];

const STABLE_LIKE = /^(USDC|USDbC|USDT|USDT0|DAI|USDS|USDe|USDG|sUSD|crvUSD|LUSD|FRAX|USR|VCHF|jEUR|EURC|sjEUR|syrupUSDG|spUSDG)$/i;
const isStableLike = (symbol: string): boolean => STABLE_LIKE.test(symbol.replace(/[^A-Za-z0-9]/g, ''));

const BASE_V2: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', feeModel: { kind: 'fixed-bps', feeBps: 30, protocol: 'uniswap-v2' } },
  { label: 'Sushi V2', router: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891', feeModel: { kind: 'fixed-bps', feeBps: 30, protocol: 'sushiswap-v2' } },
];

const RH_V2: RouterCandidate[] = [
  { label: 'Uniswap V2', router: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba', feeModel: { kind: 'fixed-bps', feeBps: 30, protocol: 'uniswap-v2' } },
  { label: 'Froth legacy V2', router: '0xE454aD44efe310Fc893d919C2b1C0ea06893Efb6', feeModel: { kind: 'unsupported', reason: 'legacy router fee model has not been verified' } },
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
    if (isStableLike(token.symbol) && !quotes.some((quote) => getAddress(quote.address) === getAddress(token.address))) continue;
    tokens.set(getAddress(token.address).toLowerCase(), {
      ...token,
      address: getAddress(token.address) as Address,
    });
  }

  const allTokens = [...tokens.values()];
  for (let left = 0; left < allTokens.length; left++) {
    for (let right = left + 1; right < allTokens.length; right++) {
      const first = allTokens[left]!;
      const second = allTokens[right]!;
      if (isStableLike(first.symbol) && isStableLike(second.symbol)) continue;
      const dedupe = keyOf(first.address, second.address);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const pair: V2PairConfig = {
        chain,
        tokenA: { symbol: first.symbol, address: first.address, decimals: first.decimals },
        tokenB: { symbol: second.symbol, address: second.address, decimals: second.decimals },
        routers,
      };
      v2.push(pair);
      if (chain === 'base') {
        for (const stable of [false, true]) {
          solidly.push({
            chain, tokenA: pair.tokenA, tokenB: pair.tokenB,
            pool: {
              chain, label: `Aerodrome (${stable ? 'stable' : 'volatile'})`,
              router: BASE_AERODROME_ROUTER, factory: BASE_AERODROME_FACTORY, stable,
            },
          });
        }
      }
    }
  }
  return { v2, solidly };
}
