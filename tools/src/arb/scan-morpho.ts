import { evmChains } from '../config/chains.js';
import { loadToolEnv } from '../config/env.js';
import { deploymentFor, loadDeployments, loadStablecoins, type Address } from '../config/registry.js';
import { scanMorphoBalances } from '../morpho/scanner.js';
import { scanArbOpportunities } from './scanner.js';

loadToolEnv();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1];
  return fallback;
}

const key = arg('chain');
if (!key) {
  console.error('usage: npx tsx src/arb/scan-morpho.ts --chain base|robinhood [--min-tvl 1000] [--max-tokens 25] [--min-usd 10000]');
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

const result = await scanArbOpportunities({
  chain,
  rpcUrl: rpc,
  seedTokens: seeds,
  minTvlUsd: minTvl,
  onProgress: (m) => console.log(m),
});

console.log(`\n${chain.name} block ${result.blockNumber}`);
for (const p of result.spotPrices) {
  const dev = p.deviationPct === null ? '' : ` ${p.deviationPct >= 0 ? '+' : ''}${p.deviationPct.toFixed(3)}%`;
  const tvl = p.tvlUsd == null ? '' : ` tvl~$${Math.round(p.tvlUsd)}`;
  console.log(`${p.pairLabel.padEnd(16)} ${p.venue.padEnd(22)} ${p.tokenAPerTokenB.toFixed(6)}${dev}${tvl}`);
}
if (result.opportunities.length) {
  console.log('\nopportunities:');
  for (const o of result.opportunities) {
    console.log(`${o.pairLabel} loan ${o.loanTokenSymbol} ${o.buyOn}->${o.sellOn} gross ${o.grossProfitFormatted} net ${o.netProfit ?? 'n/a'}`);
  }
} else {
  console.log('\nno two-venue opportunity above fees/impact at this block');
}
for (const s of result.skipped.slice(0, 30)) console.log(`skip ${s.pairLabel} ${s.router}: ${s.reason}`);
for (const w of result.warnings) console.log(`i ${w}`);
