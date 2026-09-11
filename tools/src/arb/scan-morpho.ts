import { evmChains } from '../config/chains.js';
import { loadToolEnv } from '../config/env.js';
import { deploymentFor, loadDeployments, loadStablecoins, type Address } from '../config/registry.js';
import { scanMorphoBalances } from '../morpho/scanner.js';
import { v2Pairs } from './routes.js';
import { expandPairs } from './discover.js';
import { scanArbOpportunities } from './scanner.js';

loadToolEnv();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const key = arg('chain');
if (!key) {
  console.error('usage: npx tsx src/arb/scan-morpho.ts --chain base|robinhood');
  process.exit(1);
}
const chain = evmChains.find((c) => c.key === key);
if (!chain) {
  console.error(`unknown chain ${key}`);
  process.exit(1);
}
const rpc = process.env[chain.rpcEnv];
if (!rpc) {
  console.error(`${chain.rpcEnv} missing in .env`);
  process.exit(1);
}

const minTvl = Number(arg('min-tvl', '1000'));
const maxTokens = Number(arg('max-tokens', '25'));
const minUsd = Number(arg('min-usd', '10000'));

const registry = await loadDeployments();
const record = deploymentFor(registry, chain.key);
if (!record?.morpho) {
  console.error(`no morpho in deployments.json for ${chain.key}`);
  process.exit(1);
}

console.log(`Loading Morpho assets on ${chain.name}...`);
const morpho = await scanMorphoBalances({
  chain,
  morpho: record.morpho as Address,
  rpcUrl: rpc,
  stablecoins: await loadStablecoins(),
  minimumUsd: minUsd,
});
const seeds = morpho.assets
  .filter((a) => a.decimals > 0 && a.symbol)
  .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
  .slice(0, maxTokens)
  .map((a) => ({ symbol: a.symbol, address: a.address, decimals: a.decimals, priceUsd: a.priceUsd }));
console.log(`Using ${seeds.length} Morpho assets (inventory >= $${minUsd}, cap ${maxTokens})`);
console.log(seeds.map((s) => s.symbol).join(', '));

const extra = expandPairs(chain.key, seeds, v2Pairs.filter((p) => p.chain === chain.key));
console.log(`expanded pairs: ${extra.v2.length} (plus static). examples: ${extra.v2.slice(0, 15).map((p) => `${p.tokenA.symbol}/${p.tokenB.symbol}`).join(', ')}`);

const result = await scanArbOpportunities({
  chain,
  rpcUrl: rpc,
  seedTokens: seeds,
  minTvlUsd: minTvl,
  onProgress: (m) => console.log(m),
});

console.log(`\n${chain.name} block ${result.blockNumber}  quoted venues: ${result.spotPrices.length}`);
for (const p of result.spotPrices) {
  const dev = p.deviationPct === null ? '' : ` ${p.deviationPct >= 0 ? '+' : ''}${p.deviationPct.toFixed(3)}%`;
  console.log(`${p.pairLabel.padEnd(16)} ${p.venue.padEnd(22)} ${p.tokenAPerTokenB.toFixed(6)}${dev}`);
}
if (result.opportunities.length) {
  console.log('\nopportunities:');
  for (const o of result.opportunities) {
    console.log(`${o.pairLabel} ${o.loanTokenSymbol} ${o.buyOn}->${o.sellOn} gross ${o.grossProfitFormatted}`);
  }
} else {
  console.log('\nno two-venue opportunity above fees/impact at this block');
}
