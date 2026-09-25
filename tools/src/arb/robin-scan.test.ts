import test from 'node:test';
import assert from 'node:assert/strict';
import * as robin from './robin-scan.js';
import {encodeAbiParameters,parseAbiParameters,keccak256} from 'viem';

test('RobinArb pool identity preserves fee, tick spacing and hooks', () => {
 const key={currency0:'0x0000000000000000000000000000000000000000',currency1:'0x45c2a2462e4ffc37e9698b46361f0f6444544663',fee:250000,tickSpacing:5000,hooks:'0x0000000000000000000000000000000000000000'} as const;
 const id=keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),Object.values(key) as [typeof key.currency0,typeof key.currency1,number,number,typeof key.hooks]));
 assert.equal(robin.checkedPool({...key,id}).id,id);
 assert.throws(()=>robin.checkedPool({...key,id:'0x'+'00'.repeat(32)}),/identity/);
 assert.throws(()=>robin.checkedPool({...key,currency1:'bad',id}),/address/);
});
test('tiny positive flashloan quote is retained; gas loss is explicit', () => {
 const r=robin.profit(1000n,1001n,2n);
 assert.equal(r.grossProfitRaw,1n);assert.equal(r.netAfterGasEstimateRaw,-1n);assert.equal(r.positiveGross,true);assert.equal(r.positiveNetEstimate,false);
 assert.equal(robin.profit(1000n,1003n,2n).positiveNetEstimate,true);
});
test('graduated or ready-to-graduate curves never enter the active pool scan', () => {
 assert.equal(typeof robin.activeCurve,'function');
 assert.equal(robin.activeCurve([10n,2n,100n,8n,0n,0n,0n,false,false]),true);
 assert.equal(robin.activeCurve([10n,2n,100n,8n,0n,0n,0n,false,true]),false);
 assert.equal(robin.activeCurve([10n,2n,100n,8n,0n,0n,0n,true,false]),false);
});
test('rate limits retry, contract reverts do not become zero quotes', async () => {
 assert.equal(typeof robin.retryRead,'function');
 let calls=0;assert.equal(await robin.retryRead(async()=>{if(++calls<3)throw new Error('RPC HTTP 429');return 7;},async()=>{}),7);
 assert.equal(calls,3);
 await assert.rejects(robin.retryRead(async()=>{throw new Error('execution reverted');},async()=>{}),/reverted/);
});
test('scanner RPC rejects state-changing methods', async () => {
 await assert.rejects(robin.publicRpc('eth_sendRawTransaction',['0xdeadbeef']),/read-only/);
});
