import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createPublicClient, fallback, http, parseAbi, getAddress, zeroAddress, formatUnits, type Address, type Abi } from 'viem';

export function renderDexReport(report: {status:string; counts:Record<string,number>; tokens:Array<{symbol?:string;address?:string;status:string;validQuotes?:number}>; routes:Array<{symbol?:string;buy:string;sell:string;amountInRaw:bigint;status:string;grossProfitRaw?:bigint;netProfitEstimateRaw?:bigint}>; limitations:string[]}) {
  const positive = report.routes.filter(r=>r.status==='quoted' && (r.grossProfitRaw??0n)>0n);
  const best = new Map<string, typeof positive[number]>();
  for (const row of positive) {
    const key = `${row.symbol}:${row.buy}:${row.sell}`;
    if (!best.has(key) || row.grossProfitRaw! > best.get(key)!.grossProfitRaw!) best.set(key,row);
  }
  return [JSON.stringify({status:report.status,...report.counts}),
    ...report.tokens.map(t=>`${t.symbol??'?'} ${t.address??''}: ${t.status}; ${t.validQuotes??0} valid round-trip quotes`),
    'POSITIVE GROSS CANDIDATES (unverified execution; no minimum profit threshold)',
    ...[...best.values()].sort((a,b)=>a.grossProfitRaw!>b.grossProfitRaw!?-1:1).map(r=>`${r.symbol} | ${r.buy} / ${r.sell} | loan ${formatUnits(r.amountInRaw,18)} WETH | gross ${formatUnits(r.grossProfitRaw!,18)} WETH | estimated net ${r.netProfitEstimateRaw===undefined?'unknown':formatUnits(r.netProfitEstimateRaw,18)}`),
    ...(positive.length?[]:['No positive gross quote in completed routes; coverage/failures are in the report.']),
  ].join('\n');
}
import { base } from 'viem/chains';
import { BASE_AERODROME_FACTORY, BASE_AERODROME_ROUTER, v2Pairs } from './routes.js';

export const isStableSymbol = (s: string): boolean => /^(.*USD.*|DAI|USDT0?|USDC|USDbC|USR|MAI|MIM|DOLA|FRAX|LUSD|EURC|jEUR|VCHF)$/i.test(s.replace(/[^a-z0-9]/gi,''));
export async function boundedMap<T,R>(items:T[], concurrency:number, fn:(item:T,index:number)=>Promise<R>):Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency<1) throw new Error('invalid concurrency');
  const out:R[]=[];let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{while(cursor<items.length){const i=cursor++;out[i]=await fn(items[i]!,i);}}));
  return out;
}
export async function readBatches<T,R>(items:T[], run:(batch:T[])=>Promise<R[]>, expired:()=>boolean, size=24):Promise<R[]> {
  if (!Number.isInteger(size) || size<1) throw new Error('invalid batch size');
  const rows:R[]=[];
  for (let i=0;i<items.length;i+=size) {
    if (expired()) throw new Error('scan time budget exhausted');
    const batch=items.slice(i,i+size), result=await run(batch);
    if (result.length!==batch.length) throw new Error('incomplete batch response');
    rows.push(...result);
  }
  return rows;
}
export async function quoteRoundTrip(amount:bigint, first:(n:bigint)=>Promise<bigint>, second:(n:bigint)=>Promise<bigint>) {
  if(amount<=0n) throw new Error('amount must be positive');
  const intermediateRaw=await first(amount); if(intermediateRaw<=0n) throw new Error('zero first-leg output');
  const returnedRaw=await second(intermediateRaw); if(returnedRaw<=0n) throw new Error('zero second-leg output');
  return {intermediateRaw,returnedRaw,grossProfitRaw:returnedRaw-amount};
}
export function loanSizes(maximum: bigint): bigint[] {
  if (maximum <= 0n) return [];
  const values = new Set<bigint>([maximum]);
  for (let n = 10n**12n; n < maximum; n *= 10n) {
    values.add(n);
    if (n * 3n < maximum) values.add(n * 3n);
  }
  return [...values].sort((a,b)=>a<b?-1:a>b?1:0);
}
const WETH:Address='0x4200000000000000000000000000000000000006';

/** Indexer supplies identities only. Prices never enter executable quotes. */
export function tokensFromPools(input: unknown): Token[] {
  const page = input as { data?: Array<{ relationships?: Record<string, { data?: { id?: string } }> }>; included?: Array<{id: string; type: string; attributes: {address: string; symbol: string; decimals: number}}> };
  if (!Array.isArray(page?.data) || !Array.isArray(page.included)) throw new Error('invalid pool discovery response');
  const metadata = new Map<string, Token>();
  for (const item of page.included) {
    if (item.type !== 'token') continue;
    const a = item.attributes;
    if (!/^0x[0-9a-fA-F]{40}$/.test(a?.address)) throw new Error('invalid discovery token address');
    const address = getAddress(a.address);
    if (typeof a.symbol !== 'string' || !a.symbol.length || !Number.isInteger(a.decimals) || a.decimals < 0 || a.decimals > 255) throw new Error('invalid discovery metadata');
    metadata.set(item.id, {address, symbol:a.symbol, decimals:a.decimals, status:'discovered'});
  }
  const tokens = new Map<string, Token>();
  for (const pool of page.data) for (const side of ['base_token', 'quote_token']) {
    const id = pool.relationships?.[side]?.data?.id;
    const token = id ? metadata.get(id) : undefined;
    if (!token) throw new Error('missing pool token metadata');
    if (token.address !== WETH) tokens.set(token.address.toLowerCase(), token);
  }
  return [...tokens.values()];
}
const abi=parseAbi([
  'function allPoolsLength() view returns (uint256)', 'function allPools(uint256) view returns (address)',
  'function token0() view returns (address)', 'function token1() view returns (address)',
  'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function factory() view returns (address)', 'function balanceOf(address) view returns (uint256)',
  'function getPair(address,address) view returns (address)',
  'function getPool(address,address,bool) view returns (address)',
  'function getAmountsOut(uint256,address[]) view returns (uint256[])',
]);
const solidQuote=parseAbi(['function getAmountsOut(uint256,(address from,address to,bool stable,address factory)[]) view returns (uint256[])']);
const uniFactory=parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const slipFactory=parseAbi(['function getPool(address,address,int24) view returns (address)']);
const uniQuote=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)']);
const slipQuote=parseAbi(['function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,int24 tickSpacing,uint160 sqrtPriceLimitX96)) returns (uint256,uint160,uint32,uint256)']);
// Deployment references: Uniswap/sdks sdk-core/src/addresses.ts; aerodrome-finance/slipstream README + IQuoterV2.sol.
const cl=[
  {venue:'Uniswap V3',kind:'v3',factory:'0x33128a8fC17869897dcE68Ed026d694621f6FDfD',router:'0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',keys:[100,500,3000,10000]},
  {venue:'Aerodrome Slipstream',kind:'slipstream',factory:'0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A',router:'0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0',keys:[1,10,50,100,200]},
] as const;
type Pool={address:Address;token:Address;venue:string;kind:string;factory:Address;router:Address;key:number|boolean};
type Token={address:Address;symbol?:string;decimals?:number;status:string;poolCount?:number;attempts?:number;validQuotes?:number;failure?:string};
type Route={token:Address;symbol?:string;first:Address;second:Address;buy:string;sell:string;amountInRaw:bigint;status:string;intermediateRaw?:bigint;returnedRaw?:bigint;grossProfitRaw?:bigint;gasCostEstimateRaw?:bigint;netBeforeL1FeeRaw?:bigint;failure?:string;executable:false};
export async function scanBaseDex(options:{rpcUrls:string[];morpho:Address;reportPath:string;poolLimit?:number;tokenLimit?:number;amounts?:bigint[];concurrency?:number;maxSeconds?:number;onProgress?:(s:string)=>void}) {
  const poolLimit=options.poolLimit??80,tokenLimit=options.tokenLimit??30,concurrency=options.concurrency??6;
  for(const [name,n] of Object.entries({poolLimit,tokenLimit,concurrency})) if(!Number.isInteger(n)||n<1||n>1000) throw new Error(`invalid ${name}`);
  const amounts=options.amounts??[10n**15n,10n**16n];if(!amounts.length||amounts.some(n=>n<=0n)) throw new Error('invalid amounts');
  const maxSeconds=options.maxSeconds??300;if(!Number.isFinite(maxSeconds)||maxSeconds<1)throw new Error('invalid maxSeconds');
  const deadline=Date.now()+maxSeconds*1000;
  const failures:{stage:string;target:string;reason:string}[]=[];
  const report={schemaVersion:1,chain:'base',chainId:8453,readOnly:true,startedAt:new Date().toISOString(),status:'running',blockNumber:0n,blockHash:null as string|null,
    discovery:{source:'Aerodrome on-chain allPools; first + latest bounded indices; WETH counter-pools across venues',totalFactoryPools:0n,requestedPoolLimit:poolLimit,tokenLimit,indices:[] as number[],pools:[] as {index:number;address:Address;token0?:Address;token1?:Address;failure?:string}[]},
    tokens:[] as Token[],pools:[] as Pool[],routes:[] as Route[],failures,loan:{token:WETH,morpho:options.morpho,balanceRaw:0n},counts:{} as Record<string,number>,
    limitations:['Bounded factory sample, not all Base tokens/pools; WETH loan anchor only.','Quotes are estimates, not executor simulations. All routes remain non-executable pending policy, fork/preflight and fresh re-quote.','CL unsupported by deployed POC V2; no CL calldata exported.','Gas uses 600000 units; Base L1 data fee, MEV and slippage not deducted; netBeforeL1FeeRaw is not net profit.','Slipstream initial factory only; newer factories, Uniswap V4, Curve, Balancer, multihop unsupported.']};
  const save=async()=>{report.counts={tokens:report.tokens.length,discoveredPools:report.discovery.pools.length,pools:report.pools.length,attemptedRoutes:report.routes.length,validQuotes:report.routes.filter(r=>r.status==='quoted').length,failedRoutes:report.routes.filter(r=>r.status==='failed').length,positiveGrossEstimates:report.routes.filter(r=>(r.grossProfitRaw??0n)>0n).length,failures:failures.length};await mkdir(dirname(options.reportPath),{recursive:true});await writeFile(options.reportPath+'.tmp',JSON.stringify(report,(_,v)=>typeof v==='bigint'?v.toString():v,2));await rename(options.reportPath+'.tmp',options.reportPath);};
  // Never persist provider URLs or raw viem errors: these can contain API credentials.
  const message=(e:unknown)=>{const x=e as {name?:string;shortMessage?:string};return `${x.name??'Error'}: ${(x.shortMessage??(e instanceof Error ? e.message : 'read failed')).split('\n')[0]!.replace(/https?:\/\/\S+/g,'[RPC]')}`;};
  await save();
  try {
    const urls=[...new Set(options.rpcUrls)];const healthy:string[]=[];
    for(let i=0;i<urls.length;i++) {try {const c=createPublicClient({transport:http(urls[i],{timeout:6000,retryCount:0})});if(await c.getChainId()!==8453)throw new Error('wrong chain');healthy.push(urls[i]!);}catch(e){failures.push({stage:'rpc-probe',target:`endpoint-${i}`,reason:message(e)});}}
    if(!healthy.length)throw new Error('no healthy Base RPC');
    const client=createPublicClient({chain:base,transport:fallback(healthy.map(url=>http(url,{timeout:12000,retryCount:1,retryDelay:300,batch:false})),{retryCount:0})});
    const block=await client.getBlock();report.blockNumber=block.number;report.blockHash=block.hash;
    const read=async<T>(address:Address,functionName:string,args:readonly unknown[]=[],contractAbi:Abi=abi):Promise<T>=>{if(Date.now()>deadline)throw new Error('scan time budget exhausted');return client.readContract({address,abi:contractAbi,functionName,args,blockNumber:block.number}) as Promise<T>;};
    const attempt=async<T>(stage:string,target:string,fn:()=>Promise<T>):Promise<T|undefined>=>{try{return await fn();}catch(e){failures.push({stage,target,reason:message(e)});return undefined;}};
    report.loan.balanceRaw=await read<bigint>(WETH,'balanceOf',[options.morpho]);
    const gasPrice=await client.getGasPrice();
    const total=await read<bigint>(BASE_AERODROME_FACTORY,'allPoolsLength');report.discovery.totalFactoryPools=total;
    const n=Math.min(poolLimit,Number(total)),early=Math.ceil(n/2);
    report.discovery.indices=[...new Set([...Array.from({length:early},(_,i)=>i),...Array.from({length:n-early},(_,i)=>Number(total)-(n-early)+i)])];
    await boundedMap(report.discovery.indices,concurrency,async index=>{
      const address=await attempt('pool-index',String(index),()=>read<Address>(BASE_AERODROME_FACTORY,'allPools',[BigInt(index)]));if(!address)return;
      const entry:{index:number;address:Address;token0?:Address;token1?:Address;failure?:string}={index,address};report.discovery.pools.push(entry);
      try{entry.token0=await read<Address>(address,'token0');entry.token1=await read<Address>(address,'token1');}catch(e){entry.failure=message(e);failures.push({stage:'pool-tokens',target:address,reason:entry.failure});}
    });
    const tokenAddresses=[...new Set(report.discovery.pools.sort((a,b)=>a.index-b.index).flatMap(p=>[p.token0,p.token1]).filter((a):a is Address=>!!a).map(a=>getAddress(a)))].filter(a=>a!==WETH);
    report.tokens=await boundedMap(tokenAddresses,concurrency,async address=>{const token:Token={address,status:'discovered'};try{token.symbol=await read<string>(address,'symbol');token.decimals=await read<number>(address,'decimals');if(isStableSymbol(token.symbol))token.status='excluded-stable';}catch(e){token.status='metadata-failed';token.failure=message(e);failures.push({stage:'metadata',target:address,reason:token.failure});}return token;});
    const eligible=report.tokens.filter(t=>t.status==='discovered');for(const t of eligible.slice(tokenLimit))t.status='excluded-token-cap';
    const routers=await boundedMap(v2Pairs[0]!.routers,concurrency,async r=>({ ...r,factory:await attempt('router-factory',r.router,()=>read<Address>(r.router,'factory')) }));
    for(const token of eligible.slice(0,tokenLimit)) {
      token.status='scanning';options.onProgress?.(`${token.symbol} ${token.address}`);
      const candidates:{venue:string;kind:string;factory:Address;router:Address;key:number|boolean}[]=[
        ...routers.filter(r=>r.factory).map(r=>({venue:r.label,kind:'v2',factory:r.factory!,router:r.router,key:30})),
        ...[false,true].map(key=>({venue:`Aerodrome ${key?'stable':'volatile'}`,kind:'solidly',factory:BASE_AERODROME_FACTORY,router:BASE_AERODROME_ROUTER,key})),
        ...cl.flatMap(c=>c.keys.map(key=>({venue:c.venue,kind:c.kind,factory:c.factory,router:c.router,key}))),
      ];
      const pools=(await boundedMap(candidates,concurrency,async c=>{
        const address=await attempt('counter-pool',`${token.address}:${c.venue}:${c.key}`,()=>read<Address>(c.factory,c.kind==='v2'?'getPair':'getPool',c.kind==='v2'?[WETH,token.address]:[WETH,token.address,c.key],c.kind==='v3'?uniFactory:c.kind==='slipstream'?slipFactory:abi));
        if(!address||address===zeroAddress)return undefined;return {...c,address,token:token.address} as Pool;
      })).filter((p):p is Pool=>!!p);
      report.pools.push(...pools);token.poolCount=pools.length;
      const quote=async(p:Pool,tokenIn:Address,tokenOut:Address,amountIn:bigint)=>{
        if(p.kind==='v3'||p.kind==='slipstream'){
          const params=p.kind==='v3'?{tokenIn,tokenOut,amountIn,fee:Number(p.key),sqrtPriceLimitX96:0n}:{tokenIn,tokenOut,amountIn,tickSpacing:Number(p.key),sqrtPriceLimitX96:0n};
          const result=await read<readonly bigint[]>(p.router,'quoteExactInputSingle',[params],p.kind==='v3'?uniQuote:slipQuote);return result[0]!;
        }
        const path=p.kind==='v2'?[tokenIn,tokenOut]:[{from:tokenIn,to:tokenOut,stable:Boolean(p.key),factory:p.factory}];
        const result=await read<readonly bigint[]>(p.router,'getAmountsOut',[amountIn,path],p.kind==='v2'?abi:solidQuote);return result.at(-1)!;
      };
      const routes=pools.flatMap(first=>pools.filter(second=>second.address!==first.address).flatMap(second=>amounts.map(amount=>({first,second,amount}))));
      await boundedMap(routes,concurrency,async({first,second,amount})=>{
        const r:Route={token:token.address,symbol:token.symbol,first:first.address,second:second.address,buy:first.venue,sell:second.venue,amountInRaw:amount,status:'pending',executable:false};report.routes.push(r);
        if(amount>report.loan.balanceRaw){r.status='skipped-loan-liquidity';return;}
        try{Object.assign(r,await quoteRoundTrip(amount,n=>quote(first,WETH,token.address,n),n=>quote(second,token.address,WETH,n)));r.gasCostEstimateRaw=gasPrice*600000n;r.netBeforeL1FeeRaw=r.grossProfitRaw!-r.gasCostEstimateRaw;r.status='quoted';}catch(e){r.status='failed';r.failure=message(e);}
      });
      const rows=report.routes.filter(r=>r.token===token.address);token.attempts=rows.length;token.validQuotes=rows.filter(r=>r.status==='quoted').length;token.status=pools.length<2?'insufficient-pools':token.validQuotes?'quoted':'no-valid-quote';await save();
    }
    const check=await client.getBlock({blockNumber:block.number});if(check.hash!==block.hash)throw new Error('snapshot reorg');
    report.status=failures.length || report.routes.some(r=>r.status==='failed')?'partial':'complete';
  } catch(e) {report.status='failed';failures.push({stage:'scan',target:'base',reason:message(e)});}
  await save();return report;
}
