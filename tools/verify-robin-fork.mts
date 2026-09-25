import {readFile,writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {publicRpc} from './src/arb/robin-scan.js';

// Local Foundry fork only. The upstream proxy rejects all signing/broadcast methods.
const path=process.argv[2]??'../report/robin-live.json';
const report=JSON.parse(await readFile(path,'utf8'));
if(report.chainId!==4663||!report.blockNumber||!Array.isArray(report.routes))throw new Error('invalid Robinhood scan report');
const candidates=report.routes.filter((r:any)=>r.status==='quoted'&&BigInt(r.grossProfitRaw)>0n)
 .sort((a:any,b:any)=>BigInt(a.grossProfitRaw)>BigInt(b.grossProfitRaw)?-1:1);
const picked=Number(process.argv[3]??0),r=candidates[picked];
if(!r)throw new Error('no positive candidate at requested index');
const p=report.pools.find((p:any)=>p.id===r.pool);
if(!p||p.key.hooks!=='0x0000000000000000000000000000000000000000')throw new Error('unsupported pool');
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req){body+=chunk;if(body.length>2_000_000){res.writeHead(413);res.end();return;}}
 try{const input=JSON.parse(body);const run=async(q:any)=>{try{return{jsonrpc:'2.0',id:q.id,result:await publicRpc(q.method,q.params??[])}}catch(e){return{jsonrpc:'2.0',id:q.id,error:{code:-32000,message:(e as Error).message}}}};
 const out=Array.isArray(input)?await Promise.all(input.map(run)):await run(input);res.setHeader('content-type','application/json');res.end(JSON.stringify(out));}
 catch{res.writeHead(400);res.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=(server.address() as {port:number}).port;
let output='';
try {
 const child=spawn('forge',['test','--root','../evm','--use','/data/data/com.termux/files/usr/bin/solc','--offline','--match-path','test/MorphoRobinArbFork.t.sol','-vvv'],{env:{...process.env,ROBIN_FORK_RPC:`http://127.0.0.1:${port}`,ROBIN_BLOCK:String(report.blockNumber),ROBIN_MORPHO:report.loan.morpho,ROBIN_TOKEN:r.token,ROBIN_CURVE:r.curve,ROBIN_AMOUNT:r.amountInRaw,ROBIN_REVERSE:String(r.direction==='v4-curve'),ROBIN_FEE:String(p.key.fee),ROBIN_SPACING:String(p.key.tickSpacing)},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',x=>{output+=x;process.stdout.write(x)});child.stderr.on('data',x=>{output+=x;process.stderr.write(x)});
 const timer=setTimeout(()=>child.kill('SIGTERM'),180000);
 const code=await new Promise<number>((resolve,reject)=>{child.on('error',reject);child.on('exit',c=>resolve(c??1))});clearTimeout(timer);
 const verified=code===0&&output.includes('[PASS] testScannerCandidateFlashloan');
 const result={readOnly:true,block:report.blockNumber,candidate:r,pool:p.key,verifiedFlashloan:verified,realizedGrossWei:output.match(/REALIZED_GROSS_WEI\s+(\d+)/)?.[1]??null,callGasUsed:output.match(/CALL_GAS_USED\s+(\d+)/)?.[1]??null,exitCode:code};
 await writeFile(path.replace(/\.json$/,`-fork-${picked}.log`),output);
 await writeFile(path.replace(/\.json$/,`-fork-${picked}.json`),JSON.stringify(result,null,2)+'\n');
 process.exitCode=verified?0:1;
} finally {server.close();server.closeAllConnections();}
