import https from 'node:https';
import {readFile, writeFile, rename, mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {createPublicClient, custom, http, parseAbi, parseAbiParameters, encodeAbiParameters, keccak256, getAddress, zeroAddress, toHex, type Address, type Hex, type Abi} from 'viem';
import {loanSizes, readBatches} from './dex-scan.js';

// Discovery/route reference: FlipZ3ro/RobinArb d747030. No signer or funded-wallet execution imported.
export const ROBIN = {
  chainId:4663, weth:'0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  manager:'0x8366a39cc670b4001a1121b8f6a443a643e40951',
  quoter:'0x8dc178efb8111bb0973dd9d722ebeff267c98f94',
  stateView:'0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
  router:'0x8876789976decbfcbbbe364623c63652db8c0904',
  curves:['0xd861cb5DC71A0171E8F0f6586cADb069f3A35E4d','0x42B1f2Fb09502b66Ae21769b3384a7788d020d73','0x9A4a94Bd3aF6acF5567A3B22f264E08B0962B8c8','0xD69A9fDee44a42c8E614128FEda486128cB27222','0xD952A74C85a2221a7DaB185c62cfD7EBa8C94AFC','0x1bf83b71aAA0D8Bc05884C8494E86A3e1F9f0C28','0x5383a6f2BF7c516A143AA501dd0dEE63262E9B3F','0x4f85392eefcc26775da9d9bec36f07d1b26e434b'],
} as const;
const host='rpc.mainnet.chain.robinhood.com';
const agent=new https.Agent({keepAlive:true,maxSockets:4});
const safeError=(e:unknown)=>{const x=e as {shortMessage?:string;message?:string;details?:string;cause?:{message?:string}};return [x.shortMessage??x.message??'RPC failure',x.details??x.cause?.message??''].join(' ').replace(/https?:\/\/\S+/g,'[RPC]').slice(0,400);};

export async function retryRead<T>(fn:()=>Promise<T>, sleep:(ms:number)=>Promise<void> = ms=>new Promise(r=>setTimeout(r,ms))):Promise<T> {
 for(let i=0;;i++){try{return await fn();}catch(e){if(i>=4||!/429|503|rate.?limit|too many requests/i.test(safeError(e)))throw e;await sleep(750*2**i);}}
}
/** TLS still authenticates the hostname. Only public read methods are permitted. */
export async function publicRpc(method:string, params:unknown[]):Promise<unknown> {
 return retryRead(()=>rawPublicRpc(method,params));
}
async function rawPublicRpc(method:string, params:unknown[]):Promise<unknown> {
  if (!['eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getBlockByHash','eth_call','eth_getLogs','eth_gasPrice','eth_getCode','eth_getBalance','eth_getStorageAt','eth_getTransactionCount','eth_getTransactionReceipt','eth_estimateGas'].includes(method)) throw new Error('read-only RPC method required');
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method,params});
  let last:unknown;
  for(const ip of ['104.20.46.209','172.66.147.70']) {
    try {return await new Promise((resolve,reject)=>{
      const req=https.request({hostname:ip,servername:host,method:'POST',agent,headers:{host,'content-type':'application/json'}},res=>{
        let data='';res.on('data',chunk=>{data+=chunk;if(data.length>40_000_000)req.destroy(new Error('RPC response too large'));});
        res.on('end',()=>{try {if(res.statusCode!==200)throw new Error(`RPC HTTP ${res.statusCode}`);const j=JSON.parse(data);if(j.error)throw Object.assign(new Error(j.error.message),{code:j.error.code});if(!('result' in j))throw new Error('missing RPC result');resolve(j.result);}catch(e){reject(e);}});
      });
      const timer=setTimeout(()=>req.destroy(new Error('RPC timeout')),15000);
      req.on('close',()=>clearTimeout(timer));req.on('error',reject);req.end(body);
    });}catch(e){last=e;if((e as {code?:number}).code)throw e;}
  }
  throw last;
}

type PoolKey={currency0:Address;currency1:Address;fee:number;tickSpacing:number;hooks:Address};
export type RobinPool={id:Hex;key:PoolKey;blockNumber?:string;liquidityRaw?:bigint;status?:string};
export function checkedPool(input:{currency0:string;currency1:string;fee:number;tickSpacing:number;hooks:string;id:string}):RobinPool {
  for(const a of [input.currency0,input.currency1,input.hooks])if(!/^0x[0-9a-fA-F]{40}$/.test(a))throw new Error('invalid pool address');
  if(!Number.isInteger(input.fee)||input.fee<0||input.fee>=2**24||!Number.isInteger(input.tickSpacing)||input.tickSpacing<=0||input.tickSpacing>=2**23)throw new Error('invalid pool fee/tick spacing');
  const key:PoolKey={currency0:getAddress(input.currency0),currency1:getAddress(input.currency1),fee:input.fee,tickSpacing:input.tickSpacing,hooks:getAddress(input.hooks)};
  const id=keccak256(encodeAbiParameters(parseAbiParameters('address,address,uint24,int24,address'),[key.currency0,key.currency1,key.fee,key.tickSpacing,key.hooks]));
  if(id.toLowerCase()!==input.id.toLowerCase())throw new Error('pool identity mismatch');
  return {id,key};
}
export function activeCurve(v:readonly unknown[]):boolean {
  return typeof v[3]==='bigint' && v[3]>0n && typeof v[1]==='bigint' && v[1]<v[3] && typeof v[2]==='bigint' && v[2]>0n && v[7]===false && v[8]===false;
}
export function profit(amount:bigint,returned:bigint,gas:bigint) {
  const grossProfitRaw=returned-amount,netAfterGasEstimateRaw=grossProfitRaw-gas;
  return {grossProfitRaw,netAfterGasEstimateRaw,positiveGross:grossProfitRaw>0n,positiveNetEstimate:netAfterGasEstimateRaw>0n};
}
const abi=parseAbi([
 'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)',
 'function allTokensLength() view returns(uint256)', 'function allTokens(uint256) view returns(address)',
 'function curves(address) view returns (uint256 virtualEth,uint256 realEth,uint256 tokenReserve,uint256 raiseTarget,uint256 lpEth,uint256 treasuryEth,uint256 k,bool readyToGraduate,bool graduated,address creator,address feeRecipient)',
 'function quoteBuy(address,uint256) view returns(uint256)', 'function quoteSell(address,uint256) view returns(uint256)',
 'function getLiquidity(bytes32) view returns(uint128)', 'function symbol() view returns(string)',
 'function balanceOf(address) view returns(uint256)',
 'function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)',
]);
type Call={address:Address;abi:Abi;functionName:string;args?:readonly unknown[]};
type Row={token:Address;symbol?:string;curve:Address;pool:Hex;direction:'curve-v4'|'v4-curve';amountInRaw:bigint;status:string;intermediateRaw?:bigint;returnedRaw?:bigint;grossProfitRaw?:bigint;netAfterGasEstimateRaw?:bigint;gasEstimateRaw?:bigint;positiveGross?:boolean;positiveNetEstimate?:boolean;error?:string};
export async function scanRobin(options:{morpho:Address;reportPath:string;cachePath?:string;rpcUrl?:string;fromBlock?:bigint;maxSeconds?:number;tokenLimit?:number;amounts?:bigint[];onProgress?:(s:string)=>void}) {
 const started=Date.now(),deadline=started+(options.maxSeconds??300)*1000;
 if(!Number.isFinite(deadline)||deadline<=started)throw new Error('invalid time budget');
 const limit=options.tokenLimit??100;if(!Number.isInteger(limit)||limit<1||limit>10000)throw new Error('invalid token limit');
 if(options.amounts?.some(n=>n<=0n||n>=1n<<128n))throw new Error('invalid loan size');
 const cachePath=options.cachePath??'../report/robin-pools.json';
 const failures:Array<{stage:string;target:string;error:string}>=[];
 const report={chain:'robinhood',chainId:4663,readOnly:true,startedAt:new Date().toISOString(),status:'running',blockNumber:0n,blockHash:'' as string,discovery:{source:'V4 Initialize events; RobinFun curves V1-V5',fromBlock:options.fromBlock??0n,throughBlock:0n,pools:0},loan:{token:ROBIN.weth,morpho:options.morpho,balanceRaw:0n},pools:[] as RobinPool[],tokens:[] as Array<{address:Address;symbol?:string;curve?:Address;status:string;poolCount?:number;validQuotes?:number}>,routes:[] as Row[],failures,counts:{} as Record<string,number>,limitations:['Read-only quotes, not executed profit. No USD or bps profit floor.','Native ETH routes require Morpho WETH unwrap/rewrap and compatible executor.','Gas estimate 700000 units; full transaction/L1 fees must be measured in fork before calling this net profit.','Hooked V4 pools excluded because arbitrary hook behavior is not validated.','Curve-V4 routes only; other DEX route families not included in this report.']};
 const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x,2);
 const atomic=async(path:string,value:unknown)=>{await mkdir(dirname(path),{recursive:true});await writeFile(path+'.tmp',json(value));await rename(path+'.tmp',path);};
 const save=async()=>{report.counts={discoveredPools:report.discovery.pools,tokens:report.tokens.length,activeTokens:report.tokens.filter(t=>!!t.curve).length,liquidPools:report.pools.filter(p=>(p.liquidityRaw??0n)>0n).length,attemptedRoutes:report.routes.length,validQuotes:report.routes.filter(r=>r.status==='quoted').length,failedRoutes:report.routes.filter(r=>r.status==='failed').length,positiveGrossEstimates:report.routes.filter(r=>r.positiveGross).length,positiveNetEstimates:report.routes.filter(r=>r.positiveNetEstimate).length,failures:failures.length};await atomic(options.reportPath,report);};
 const expired=()=>Date.now()>deadline;
 await save();
 try {
 const client=createPublicClient({transport:options.rpcUrl?http(options.rpcUrl,{timeout:12000,retryCount:0,batch:false}):custom({request:({method,params})=>publicRpc(method,params as unknown[]??[])},{retryCount:0})});
 if(await client.getChainId()!==ROBIN.chainId)throw new Error('wrong chain');
 const head=await client.getBlock();report.blockNumber=head.number;report.blockHash=head.hash;
 const read=async<T>(address:Address,functionName:string,args:readonly unknown[]=[])=>client.readContract({address,abi:abi as Abi,functionName,args,blockNumber:head.number}) as Promise<T>;
 const multi=async(calls:Call[])=>readBatches(calls,async contracts=>{
   try{return await client.multicall({contracts,multicallAddress:'0xcA11bde05977b3631167028862bE2a173976CA11',blockNumber:head.number,allowFailure:true,batchSize:0});}
   catch(e){return contracts.map(()=>({status:'failure' as const,error:e instanceof Error?e:new Error(safeError(e))}));}
 },expired,80);
 report.loan.balanceRaw=await read<bigint>(ROBIN.weth,'balanceOf',[options.morpho]);
 const gasPrice=await client.getGasPrice(),gasCost=gasPrice*700000n;
 const lengths=await multi(ROBIN.curves.map(address=>({address,abi,functionName:'allTokensLength'})));
 const indices:Array<{curve:Address;index:bigint}>=[];
 for(let i=0;i<lengths.length;i++){const r=lengths[i]!;if(r.status==='failure')throw new Error(`factory ${ROBIN.curves[i]} count failed: ${safeError(r.error)}`);const n=r.result as bigint;if(n>100000n)throw new Error('factory index exceeds scan budget');for(let j=0n;j<n;j++)indices.push({curve:ROBIN.curves[i]!,index:j});}
 const addresses=await multi(indices.map(c=>({address:c.curve,abi,functionName:'allTokens',args:[c.index]})));
 const checks:Array<{token:Address;curve:Address}>=[];
 for(let i=0;i<addresses.length;i++){const r=addresses[i]!;if(r.status==='failure'){failures.push({stage:'token-index',target:`${indices[i]!.curve}:${indices[i]!.index}`,error:safeError(r.error)});continue;}checks.push({token:getAddress(r.result as Address),curve:indices[i]!.curve});}
 const tokens=[...new Set(checks.map(c=>c.token))];report.tokens=tokens.map(address=>({address,status:'checking-curve'}));await save();
 const state=await multi(checks.map(c=>({address:c.curve,abi,functionName:'curves',args:[c.token]})));
 for(let i=0;i<state.length;i++){const r=state[i]!,c=checks[i]!;const token=report.tokens.find(t=>t.address===c.token)!;if(r.status==='failure'){token.status='curve-read-failed';failures.push({stage:'curve',target:`${c.token}:${c.curve}`,error:safeError(r.error)});continue;}if(activeCurve(r.result as readonly unknown[])){token.curve=c.curve;token.status='active';}else token.status='no-active-curve';}
 await save();options.onProgress?.(`${tokens.length} factory tokens; ${report.tokens.filter(t=>t.curve).length} active curves`);
 const all=new Map<string,RobinPool>();let from=options.fromBlock??0n;
 const tokenSet=keccak256(toHex([...tokens].sort().join(',')));
 try {const c=JSON.parse(await readFile(cachePath,'utf8'));if(c.schema===2 && c.chainId===4663 && c.tokenSet===tokenSet){const b=await client.getBlock({blockNumber:BigInt(c.throughBlock)});if(b.hash!==c.throughHash)throw new Error('cached discovery reorg');for(const p of c.pools){const v=checkedPool({...p.key,id:p.id});all.set(v.id,{...v,blockNumber:p.blockNumber});}from=BigInt(c.throughBlock)+1n;}}
 catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')failures.push({stage:'cache',target:'pool-index',error:safeError(e)});}
 const logs=async(a:bigint,b:bigint,group:Address[]):Promise<void>=>{
   if(expired())throw new Error('scan time budget exhausted');
   if(a>b)return;
   try {const found=await client.getLogs({address:ROBIN.manager,event:abi[0],args:{currency0:zeroAddress,currency1:group},fromBlock:a,toBlock:b,strict:true});
     for(const l of found){const p=checkedPool(l.args);all.set(p.id,{...p,blockNumber:String(l.blockNumber)});}
   }catch(e){if(a===b||!/limit|range|too (many|large)|exceed|timed?\s*out|timeout/i.test(safeError(e)))throw e;const mid=(a+b)/2n;await logs(a,mid,group);await logs(mid+1n,b,group);}
 };
 for(let i=0;i<tokens.length;i+=64){await logs(from,head.number,tokens.slice(i,i+64));report.discovery.pools=all.size;await save();}
 await atomic(cachePath,{schema:2,chainId:4663,tokenSet,throughBlock:String(head.number),throughHash:head.hash,pools:[...all.values()]});
 report.discovery.throughBlock=head.number;report.discovery.pools=all.size;
 const active=new Map(report.tokens.filter(t=>t.curve).map(t=>[t.address,t]));
 report.pools=[...all.values()].filter(p=>active.has(p.key.currency1));
 const liquidity=await multi(report.pools.map(p=>({address:ROBIN.stateView,abi,functionName:'getLiquidity',args:[p.id]})));
 for(let i=0;i<liquidity.length;i++){const r=liquidity[i]!,p=report.pools[i]!;if(r.status==='failure'){p.status='liquidity-read-failed';failures.push({stage:'liquidity',target:p.id,error:safeError(r.error)});}else{p.liquidityRaw=r.result as bigint;p.status=p.key.hooks!==zeroAddress?'unsupported-hooks':p.liquidityRaw>0n?'liquid':'zero-liquidity';}}
 const liquid=report.pools.filter(p=>p.status==='liquid');
 const ready=report.tokens.filter(t=>t.curve && liquid.some(p=>p.key.currency1===t.address));
 for(const t of report.tokens.filter(t=>t.curve)){t.poolCount=liquid.filter(p=>p.key.currency1===t.address).length;if(!t.poolCount)t.status='no-usable-v4-pool';}
 const symbols=await multi(ready.map(t=>({address:t.address,abi,functionName:'symbol'})));
 ready.forEach((t,i)=>{if(symbols[i]?.status==='success')t.symbol=String(symbols[i]!.result);});
 for(const t of ready.slice(limit))t.status='token-cap';
 await save();options.onProgress?.(`${report.discovery.pools} pools; ${tokens.length} tokens; ${ready.length} active tokens with liquid V4`);
 const sizes=(options.amounts??loanSizes(report.loan.balanceRaw)).filter(n=>n<=report.loan.balanceRaw && n<(1n<<128n));
 for(const token of ready.slice(0,limit)){
   if(expired())throw new Error('scan time budget exhausted');
   const pools=liquid.filter(p=>p.key.currency1===token.address);
   const jobs=pools.flatMap(p=>sizes.flatMap(n=>[false,true].map(reverse=>({p,n,reverse}))));
   const quoteCall=(p:RobinPool,buy:boolean,amount:bigint):Call=>({address:ROBIN.quoter,abi,functionName:'quoteExactInputSingle',args:[{poolKey:p.key,zeroForOne:buy,exactAmount:amount,hookData:'0x'}]});
   const first=await multi(jobs.map(j=>j.reverse?quoteCall(j.p,true,j.n):{address:token.curve!,abi,functionName:'quoteBuy',args:[token.address,j.n]}));
   const secondJobs:Array<{index:number;amount:bigint;call:Call}>=[];
   const rows=jobs.map((j,i):Row=>{
     const row:Row={token:token.address,symbol:token.symbol,curve:token.curve!,pool:j.p.id,direction:j.reverse?'v4-curve':'curve-v4',amountInRaw:j.n,status:'pending'};
     const r=first[i]!;if(r.status==='failure'){row.status='failed';row.error=safeError(r.error);return row;}
     const amount=j.reverse?(r.result as readonly bigint[])[0]!:r.result as bigint;
     if(amount<=0n||amount>=(1n<<128n)){row.status='failed';row.error='first output zero or outside V4 uint128';return row;}
     row.intermediateRaw=amount;secondJobs.push({index:i,amount,call:j.reverse?{address:token.curve!,abi,functionName:'quoteSell',args:[token.address,amount]}:quoteCall(j.p,false,amount)});return row;
   });
   report.routes.push(...rows);await save();
   const second=await multi(secondJobs.map(j=>j.call));
   second.forEach((r,k)=>{const j=secondJobs[k]!,row=rows[j.index]!,job=jobs[j.index]!;if(r.status==='failure'){row.status='failed';row.error=safeError(r.error);return;}const back=job.reverse?r.result as bigint:(r.result as readonly bigint[])[0]!;if(back<=0n){row.status='failed';row.error='zero second output';return;}Object.assign(row,profit(row.amountInRaw,back,gasCost),{returnedRaw:back,gasEstimateRaw:gasCost,status:'quoted'});});
   token.validQuotes=rows.filter(r=>r.status==='quoted').length;token.status=token.validQuotes?'quoted':'no-valid-quote';await save();
   const best=rows.filter(r=>r.status==='quoted').sort((a,b)=>a.grossProfitRaw!>b.grossProfitRaw!?-1:1)[0];
   options.onProgress?.(`${token.symbol??token.address}: ${token.validQuotes}/${rows.length} quotes; best gross wei ${best?.grossProfitRaw??'unknown'}`);
 }
 if((await client.getBlock({blockNumber:head.number})).hash!==head.hash)throw new Error('snapshot reorg');
 report.status=failures.length||report.routes.some(r=>r.status==='failed')||ready.length>limit?'partial':'complete';
 }catch(e){report.status='failed';failures.push({stage:'scan',target:'robinhood',error:safeError(e)});}
 await save();return report;
}
