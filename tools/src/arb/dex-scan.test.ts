import test from 'node:test';
import assert from 'node:assert/strict';
import { isStableSymbol, boundedMap, quoteRoundTrip } from './dex-scan.js';
import * as dex from './dex-scan.js';

test('active DEX discovery includes CL-only intermediates without Morpho balances', () => {
  assert.equal(typeof dex.tokensFromPools, 'function', 'active pool discovery is missing');
  const token = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
  const weth = '0x4200000000000000000000000000000000000006';
  const usdc = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
  const payload = {included:[
    {id:`base_${token}`,type:'token',attributes:{address:token,symbol:'AERO',decimals:18}},
    {id:`base_${weth}`,type:'token',attributes:{address:weth,symbol:'WETH',decimals:18}},
    {id:`base_${usdc}`,type:'token',attributes:{address:usdc,symbol:'USDC',decimals:6}},
  ],data:[{attributes:{address:'0x18eC0aFa38E54850f51f03A673352DDd0FFFD8BA'},relationships:{base_token:{data:{id:`base_${token}`}},quote_token:{data:{id:`base_${weth}`}}}},
  {attributes:{address:'0x9E88239ac8c225e4Fe63c72A4c7fc9D1c9Ef7e24'},relationships:{base_token:{data:{id:`base_${token}`}},quote_token:{data:{id:`base_${usdc}`}}}}]};
  const tokens = dex.tokensFromPools(payload);
  assert.deepEqual(tokens.map(t=>t.address), [token, usdc]);
  assert.equal(tokens[0]?.symbol, 'AERO');
  assert.throws(()=>dex.tokensFromPools({data:[],included:[{type:'token',attributes:{address:'bad',symbol:'SCAM'}}]}), /address/);
});
test('loan sizing searches below and above fixed amounts without exceeding flash liquidity', () => {
  assert.equal(typeof dex.loanSizes, 'function', 'adaptive loan range is missing');
  const sizes = dex.loanSizes(37n * 10n**18n);
  assert.ok(sizes.includes(10n**13n));
  assert.ok(sizes.includes(10n**18n));
  assert.ok(sizes.includes(37n*10n**18n));
  assert.ok(sizes.every(n=>n>0n && n<=37n*10n**18n));
  assert.deepEqual(dex.loanSizes(0n), []);
  assert.deepEqual(dex.loanSizes(1n), [1n]);
});

test('gross profit of one wei is retained and displayed without a minimum threshold', async () => {
  assert.equal(typeof dex.renderDexReport, 'function', 'profitable routes must be visible, not counts only');
  const row = await quoteRoundTrip(100n, async()=>101n, async n=>n);
  const text = dex.renderDexReport({status:'partial', counts:{validQuotes:1}, tokens:[], routes:[{symbol:'AERO',buy:'V2',sell:'V3',amountInRaw:100n,status:'quoted',...row}], limitations:[]});
  assert.match(text, /AERO/); assert.match(text, /0\.000000000000000001/); assert.match(text, /unverified|belum/i);
});

test('batched reads retain per-call failures and enforce the deadline', async () => {
  assert.equal(typeof dex.readBatches, 'function', 'batched RPC reads are missing');
  let batches=0;
  const run=async (items:number[])=>{batches++;return items.map(n=>n===2?{status:'failure' as const,error:new Error('revert')}:{status:'success' as const,result:n*2});};
  const rows=await dex.readBatches([1,2,3,4,5],run,()=>false,2);
  assert.equal(batches,3); assert.deepEqual(rows.map(r=>r.status==='success'?r.result:'failed'),[2,'failed',6,8,10]);
  await assert.rejects(dex.readBatches([1],run,()=>true),/budget/);
});

test('stable filters include USR and MAI, not nonstable assets', () => {
  for (const s of ['USR','MAI','sUSDe','USDC','crvUSD']) assert.equal(isStableSymbol(s), true);
  for (const s of ['AERO','BRETT','DEGEN','cbBTC']) assert.equal(isStableSymbol(s), false);
});
test('bounded work preserves every item and concurrency ceiling', async () => {
  let active=0, peak=0;
  const results=await boundedMap([1,2,3,4,5],2,async n=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;return n*2;});
  assert.deepEqual(results,[2,4,6,8,10]); assert.equal(peak,2);
});
test('two-leg quote uses first output, retains negative returns, rejects zero', async () => {
 const inputs:bigint[]=[];
 const result=await quoteRoundTrip(100n,async amount=>{inputs.push(amount);return 90n;},async amount=>{inputs.push(amount);return 80n;});
 assert.deepEqual(inputs,[100n,90n]);assert.equal(result.grossProfitRaw,-20n);
 await assert.rejects(quoteRoundTrip(100n,async()=>0n,async()=>1n),/zero/);
});
