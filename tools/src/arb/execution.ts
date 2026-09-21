import { getAddress, keccak256, parseAbi, type Hex, type PublicClient } from 'viem';
import type { Address } from '../config/registry.js';
import type { ArbOpportunity } from './scanner.js';
import { quoteExactInput } from './quotes.js';
import { encodePocV2Plan, type EncodedArbPlan, type ExecutionCostsRaw } from './plan.js';

export const arbExecutorAbi = parseAbi([
  'function owner() view returns (address)', 'function morpho() view returns (address)',
  'function allowedToken(address) view returns (bool)', 'function allowedRouter(address) view returns (bool)',
  'function allowedAerodromeFactory(address) view returns (bool)',
  'function executeArbitrage((address loanToken,address intermediateToken,(address router,address pool,uint8 kind,bool aeroStable,address aeroFactory) firstLeg,(address router,address pool,uint8 kind,bool aeroStable,address aeroFactory) secondLeg,uint256 loanAmount,uint256 minIntermediateAmount,uint256 minFinalAmount,uint256 minProfit,uint256 deadline,address profitReceiver) params) returns (uint256)',
]);
const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)']);

/** Re-quote both legs at one fresh block; scanner math is discovery only. */
export async function requoteOpportunity(client: PublicClient, opportunity: ArbOpportunity) {
  const blockNumber = await client.getBlockNumber();
  const block = await client.getBlock({ blockNumber });
  const venue = (leg: 'buy' | 'sell') => ({
    kind: leg === 'buy' ? opportunity.buyKind : opportunity.sellKind,
    label: leg === 'buy' ? opportunity.buyOn : opportunity.sellOn,
    router: leg === 'buy' ? opportunity.buyRouter : opportunity.sellRouter,
    factory: leg === 'buy' ? opportunity.buyFactory : opportunity.sellFactory,
    pool: leg === 'buy' ? opportunity.buyPool : opportunity.sellPool,
    fee: leg === 'buy' ? opportunity.buyFee : opportunity.sellFee,
  });
  const first = await quoteExactInput(client, { venue: venue('buy'), tokenIn: opportunity.loanToken, tokenOut: opportunity.intermediateToken, amountInRaw: opportunity.loanAmountRaw, snapshotBlock: blockNumber });
  const second = await quoteExactInput(client, { venue: venue('sell'), tokenIn: opportunity.intermediateToken, tokenOut: opportunity.loanToken, amountInRaw: first.amountOutRaw, snapshotBlock: blockNumber });
  return {
    opportunity: { ...opportunity, blockNumber, blockHash: block.hash ?? '0x', blockTimestamp: block.timestamp },
    quotes: { firstLegAmountOutRaw: first.amountOutRaw, secondLegAmountOutRaw: second.amountOutRaw, blockNumber },
  };
}

export function makePlan(opportunity: ArbOpportunity, quotes: Awaited<ReturnType<typeof requoteOpportunity>>['quotes'], input: { profitReceiver: Address; slippageBps: number; deadlineSeconds: number; costs: ExecutionCostsRaw; minNetProfitRaw?: bigint; minNetProfitBps?: number }): EncodedArbPlan {
  return encodePocV2Plan(opportunity, { quotes, ...input });
}

export type ArbDeployment = { address: Address; version: string; bytecodeHash: Hex; owner: Address; morpho: Address; tokens: Address[]; routers: Address[]; aerodromeFactories: Address[] };

/** Fail-closed validation immediately before simulation/broadcast. */
export async function verifyArbPreflight(client: PublicClient, expectedChainId: number, deployment: ArbDeployment, plan: EncodedArbPlan): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== expectedChainId) throw new Error(`RPC chainId ${chainId}, expected ${expectedChainId}`);
  const blockNumber = await client.getBlockNumber();
  const code = await client.getBytecode({ address: deployment.address, blockNumber });
  if (!code || code === '0x' || keccak256(code) !== deployment.bytecodeHash) throw new Error('executor bytecode hash mismatch');
  const [owner, morpho, morphoBalance, staleAllowance] = await Promise.all([
    client.readContract({ address: deployment.address, abi: arbExecutorAbi, functionName: 'owner', blockNumber }),
    client.readContract({ address: deployment.address, abi: arbExecutorAbi, functionName: 'morpho', blockNumber }),
    client.readContract({ address: plan.opportunity.loanToken, abi: erc20Abi, functionName: 'balanceOf', args: [deployment.morpho], blockNumber }),
    client.readContract({ address: plan.opportunity.loanToken, abi: erc20Abi, functionName: 'allowance', args: [deployment.address, deployment.morpho], blockNumber }),
  ]);
  if (getAddress(owner) !== getAddress(deployment.owner)) throw new Error('executor owner mismatch');
  if (getAddress(morpho) !== getAddress(deployment.morpho)) throw new Error('executor Morpho mismatch');
  if (morphoBalance < plan.loanAmountRaw) throw new Error('insufficient Morpho balance');
  if (staleAllowance !== 0n) throw new Error('unexpected stale Morpho allowance');
  if (plan.profitReceiver === '0x0000000000000000000000000000000000000000') throw new Error('invalid profit receiver');
  const latest = await client.getBlock({ blockNumber });
  if (plan.deadline <= latest.timestamp) throw new Error('plan deadline expired');
  const checks = [
    ...deployment.tokens.map((address) => ({ address, functionName: 'allowedToken' as const })),
    ...deployment.routers.map((address) => ({ address, functionName: 'allowedRouter' as const })),
    ...deployment.aerodromeFactories.map((address) => ({ address, functionName: 'allowedAerodromeFactory' as const })),
  ];
  for (const check of checks) {
    const allowed = await client.readContract({ address: deployment.address, abi: arbExecutorAbi, functionName: check.functionName, args: [check.address], blockNumber });
    if (!allowed) throw new Error(`${check.functionName} missing ${check.address}`);
  }
}
