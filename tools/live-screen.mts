import { writeFile, appendFile } from 'node:fs/promises';
import { createPublicClient, fallback, http } from 'viem';
import { loadToolEnv } from './src/config/env.js';
import { evmChains } from './src/config/chains.js';
import { loadDeployments, deploymentFor, loadStablecoins } from './src/config/registry.js';
import { scanMorphoBalances } from './src/morpho/scanner.js';
import { expandPairs } from './src/arb/discover.js';
import { v2Pairs, solidlyPairs } from './src/arb/routes.js';
import { scanArbOpportunities } from './src/arb/scanner.js';
loadToolEnv();
const chain = evmChains.find(c => c.key === 'base')!;
const rpcUrl = process.env.BASE_RPC_URL!;
const morpho = deploymentFor(await loadDeployments(), 'base')!.morpho as `0x${string}`;
const serialize = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v);
const output = '../report/base-live-batches.jsonl';
await writeFile(output, '');
const inventory = await scanMorphoBalances({chain, rpcUrl, morpho, stablecoins: await loadStablecoins(), minimumUsd: 0});
await writeFile('../report/base-live-inventory.json', serialize(inventory));
// ponytail: operational anchor-only screen; cross-token and concentrated pools remain outside this run.
const excluded = /usd|eur|gbp|cad|chf|xsgd|idrx|cngn|brz|cetes|jaaa|mbasis|^pt-|^yt-/i;
const seeds = inventory.assets.filter(a => a.balance > 0n && a.symbol !== '?' && !excluded.test(a.symbol) && !a.exclusionReason?.startsWith('balance-read-failed') && a.exclusionReason !== 'metadata-unavailable');
const anchors = new Set(['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0x4200000000000000000000000000000000000006']);
const extra = expandPairs('base', seeds, v2Pairs);
const pairs = [...v2Pairs.filter(p => p.chain === 'base'), ...extra.v2].filter(p => anchors.has(p.tokenA.address.toLowerCase()) || anchors.has(p.tokenB.address.toLowerCase()));
const pools = [...solidlyPairs.filter(p => p.chain === 'base'), ...extra.solidly].filter(p => !p.pool.stable);
console.log(serialize({inventory: inventory.assets.length, selectedTokens: seeds.length, pairs: pairs.length, symbols: seeds.map(a => a.symbol), warnings: inventory.warnings}));
const publicClient = createPublicClient({transport: fallback([rpcUrl, 'https://base-rpc.publicnode.com','https://mainnet.base.org'].map(url => http(url, {timeout: 8000,retryCount: 0})))});
for (let i = 0; i < pairs.length; i += 8) {
 const batch = pairs.slice(i, i + 8);
 v2Pairs.splice(0, v2Pairs.length, ...batch);
 solidlyPairs.splice(0, solidlyPairs.length, ...pools.filter(s => batch.some(p => p.tokenA.address === s.tokenA.address && p.tokenB.address === s.tokenB.address)));
 const started = Date.now();
 try {
 const result = await scanArbOpportunities({chain,rpcUrl,publicClient,morphoAddress: morpho,seedTokens: seeds.map(a => ({...a,eligible: a.eligible})),minTvlUsd:1000});
 await appendFile(output, serialize({batch:i/8, pairs:batch.map(p=>[p.tokenA,p.tokenB]),elapsedMs:Date.now()-started,result})+'\n');
 console.log(serialize({batch:i/8,pairs:batch.length,block:String(result.blockNumber),spots:result.spotPrices.length,opportunities:result.opportunities,skipped:result.skipped,warnings:result.warnings}));
 } catch(e) {await appendFile(output,serialize({batch:i/8,error:String(e).split('\n')[0]})+'\n'); console.log('BATCH_FAILED',i/8,String(e).split('\n')[0]);}
}
console.log('SCREEN_COMPLETE');
