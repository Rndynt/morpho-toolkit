import { evmChains } from '../config/chains.js';
import { loadToolEnv } from '../config/env.js';
import { deploymentFor, loadDeployments, loadStablecoins, type Address } from '../config/registry.js';
import { scanMorphoBalances } from '../morpho/scanner.js';
import { color, renderTable, ui } from '../ui/index.js';
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

ui.info(`Loading Morpho assets on ${chain.name}...`);
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
ui.info(`Using ${seeds.length} Morpho assets (>= $${minUsd} inventory, cap ${maxTokens})`);

const result = await scanArbOpportunities({
  chain,
  rpcUrl: rpc,
  seedTokens: seeds,
  minTvlUsd: minTvl,
  onProgress: (m) => console.log(`${color.cyan('◌')} ${color.dim(m)}`),
});

ui.section(`${result.chain.name} / ARBITRAGE SCAN (Morpho universe, read-only)`);
console.log(`${color.dim('Block')} ${color.white(String(result.blockNumber))}  ${color.dim('quoted rows')} ${color.white(String(result.spotPrices.length))}`);

if (result.spotPrices.length) {
  ui.section('SPOT PRICES');
  console.log(renderTable(
    [
      { title: 'PAIR' },
      { title: 'VENUE' },
      { title: 'PRICE', align: 'right' },
      { title: 'VS MEDIAN', align: 'right' },
    ],
    result.spotPrices.map((p) => [
      color.yellow(p.pairLabel),
      color.white(p.venue),
      color.dim(p.tokenAPerTokenB.toFixed(6)),
      p.deviationPct === null ? color.dim('n/a') : color.cyan(`${p.deviationPct >= 0 ? '+' : ''}${p.deviationPct.toFixed(4)}%`),
    ]),
  ));
}

const shown = result.opportunities.filter((o) => Number(o.grossProfitFormatted) >= 0.01);
if (!shown.length) {
  ui.info('No opportunity with gross >= 0.01 after fees/impact at this block.');
} else {
  ui.section('OPPORTUNITIES');
  console.log(renderTable(
    [
      { title: 'PAIR' },
      { title: 'LOAN' },
      { title: 'BUY' },
      { title: 'SELL' },
      { title: 'GROSS', align: 'right' },
      { title: 'NET', align: 'right' },
    ],
    shown.map((o) => [
      color.yellow(o.pairLabel),
      color.white(o.loanTokenSymbol),
      color.white(o.buyOn),
      color.white(o.sellOn),
      color.green(o.grossProfitFormatted),
      o.netProfit === null ? color.dim('n/a') : color.green(o.netProfit.toFixed(6)),
    ]),
  ));
}

if (result.skipped.length) {
  ui.section('SKIPPED');
  console.log(renderTable(
    [{ title: 'PAIR' }, { title: 'ROUTER' }, { title: 'REASON' }],
    result.skipped.slice(0, 40).map((s) => [s.pairLabel, s.router, s.reason]),
  ));
}
for (const w of result.warnings) ui.info(w);
