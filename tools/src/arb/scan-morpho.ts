import { evmChains } from '../config/chains.js';
import { loadToolEnv } from '../config/env.js';
import { deploymentFor, loadDeployments, loadStablecoins, type Address } from '../config/registry.js';
import { scanMorphoBalances } from '../morpho/scanner.js';
import { color, renderTable, ui } from '../ui/index.js';
import { solidlyPairs, v2Pairs } from './routes.js';
import { expandPairs } from './discover.js';
import { scanArbOpportunities } from './scanner.js';

loadToolEnv();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1]!.startsWith('--')) return process.argv[i + 1];
  return fallback;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const key = arg('chain');
if (!key) {
  console.error('usage: npx tsx src/arb/scan-morpho.ts --chain base|robinhood [--include-unpriced-discovery]');
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
const maxTokens = Number(arg('max-tokens', '1000'));
const minUsd = Number(arg('min-usd', '0'));
const includeUnpricedDiscovery = flag('include-unpriced-discovery');

// Stablecoin depeg routes are noise for this monitor. Keep major quote assets
// (USDC/WETH) as anchors, but never use stable-like discovered tokens as arb legs.
const stableLike = /^(USDC|USDbC|USDT|USDT0|DAI|USDS|USDe|USDG|sUSD|crvUSD|LUSD|FRAX|USR|VCHF|jEUR|EURC|sjEUR|syrupUSDG|spUSDG)$/i;
const isStableLike = (symbol: string): boolean => stableLike.test(symbol.replace(/[^A-Za-z0-9]/g, ''));

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
const hasValidMetadata = (asset: (typeof morpho.assets)[number]): boolean =>
  asset.symbol.trim().length > 0
  && asset.symbol !== '?'
  && Number.isInteger(asset.decimals)
  && asset.decimals >= 0;
const hasSnapshotInventory = (asset: (typeof morpho.assets)[number]): boolean =>
  asset.balance > 0n
  && asset.exclusionReason !== 'metadata-unavailable'
  && !asset.exclusionReason?.startsWith('balance-read-failed:');

// Keep discovery and executable inventory distinct. USD values are useful for
// ranking discovery results, but the executable bound is always the raw on-chain
// balance (and is refreshed by scanArbOpportunities at its quote snapshot).
const executableCandidates = morpho.assets.filter((asset) =>
  asset.eligible === true && hasValidMetadata(asset) && hasSnapshotInventory(asset));
const unpricedCandidates = morpho.assets.filter((asset) =>
  asset.exclusionReason === 'price-missing-or-stale'
  && hasValidMetadata(asset)
  && hasSnapshotInventory(asset));
const nonStableCandidates = (assets: typeof morpho.assets) => assets.filter((asset) => !isStableLike(asset.symbol));
const filteredExecutableCandidates = nonStableCandidates(executableCandidates);
const filteredUnpricedCandidates = nonStableCandidates(unpricedCandidates);
const discoveryOnly = includeUnpricedDiscovery ? filteredUnpricedCandidates : [];
// These counters describe the scan result, not the optional selection below. In
// particular, turning off unpriced discovery must not make those assets look like
// malformed/discarded inventory in the summary.
const unpricedCount = morpho.assets.filter((asset) =>
  asset.exclusionReason === 'price-missing-or-stale').length;
const discarded = morpho.assets.length - executableCandidates.length - unpricedCount;

ui.info(
  `Morpho inventory: found ${morpho.assets.length}, eligible ${executableCandidates.length}, `
  + `unpriced ${unpricedCount}, discarded ${discarded}`,
);

// Apply the cap to the two inventories separately, with executable inventory taking
// priority. This prevents an explicitly discovery-only token from displacing a
// usable raw-balance limit. Address ordering is deterministic and, deliberately,
// does not treat usdValue (or any third-party price) as liquidity evidence.
const byAddress = (a: (typeof morpho.assets)[number], b: (typeof morpho.assets)[number]): number =>
  a.address.toLowerCase().localeCompare(b.address.toLowerCase());
const executableInventory = [...filteredExecutableCandidates].sort(byAddress).slice(0, maxTokens);
const discoverySlots = Math.max(0, maxTokens - executableInventory.length);
const discoveryInventory = [...discoveryOnly].sort(byAddress).slice(0, discoverySlots);
const executableAddresses = new Set(executableInventory.map((asset) => asset.address.toLowerCase()));
const seeds = [...executableInventory, ...discoveryInventory]
  .map((a) => ({
    symbol: a.symbol, address: a.address, decimals: a.decimals,
    // Discovery-only entries are explicitly barred from execution. The arb scanner
    // also re-reads executable balances at the immutable quote snapshot.
    balance: a.balance, blockNumber: morpho.blockNumber,
    eligible: executableAddresses.has(a.address.toLowerCase()),
    // Do not forward stale scanner prices into the TVL display/filter.
    priceUsd: a.exclusionReason === 'price-missing-or-stale' ? null : a.priceUsd,
    priceTimestamp: a.priceTimestamp, priceSource: a.priceSource,
  }));
ui.info(
  `Using ${executableInventory.length} executable assets and ${discoveryInventory.length} discovery-only assets `
  + `(cap ${maxTokens}; ${Math.max(0, executableCandidates.length + discoveryOnly.length - maxTokens)} omitted by cap)`,
);
const staticPairs = v2Pairs.filter((p) => p.chain === chain.key);
const extra = expandPairs(chain.key, seeds, staticPairs);
for (const pair of extra.v2) v2Pairs.push(pair);
for (const pair of extra.solidly) solidlyPairs.push(pair);
ui.info(`quoting ${staticPairs.length + extra.v2.length} pairs across Uni/Sushi/Aero`);

const result = await scanArbOpportunities({
  chain,
  rpcUrl: rpc,
  seedTokens: seeds,
  morphoAddress: morpho.morpho,
  minTvlUsd: minTvl,
  onProgress: (m) => console.log(`${color.cyan('◌')} ${color.dim(m)}`),
});

ui.section(`${result.chain.name} / ARBITRAGE SCAN (Morpho universe, read-only)`);
console.log(`${color.dim('Snapshot')} ${color.white(String(result.blockNumber))} ${color.dim(result.blockHash)} ${color.dim(new Date(Number(result.blockTimestamp) * 1000).toISOString())}  ${color.dim('quoted rows')} ${color.white(String(result.spotPrices.length))}`);

if (result.venueTvl.length) {
  ui.section('VENUE TVL (external, non-executable pricing)');
  console.log(renderTable(
    [{ title: 'PAIR' }, { title: 'VENUE' }, { title: 'TVL USD', align: 'right' }, { title: 'SOURCE / TIMESTAMP' }, { title: 'CONFIDENCE' }, { title: 'STATUS' }],
    result.venueTvl.map((v) => [
      color.yellow(v.pairLabel), color.white(v.venue),
      v.tvlUsd === null ? color.dim('unpriced') : color.dim(`$${v.tvlUsd.toFixed(0)}`),
      color.dim(v.tokenPrices.map((p) => `${p.source ?? 'unknown'}@${p.timestamp ? new Date(p.timestamp * 1000).toISOString() : 'n/a'}`).join(' / ')),
      color.dim(v.confidence),
      v.status === 'unpriced' ? color.yellow('unpriced; review required') : color.cyan('priced'),
    ]),
  ));
}

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

const shown = result.opportunities.filter((o) => o.grossProfitRaw >= 10n ** BigInt(Math.max(0, o.loanTokenDecimals - 2)));
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
