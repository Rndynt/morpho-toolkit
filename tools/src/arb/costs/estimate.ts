import { decodeFunctionData, type Abi, type PublicClient } from 'viem';
import type { Address } from '../../config/registry.js';
import type { QuoteVenue } from '../quotes.js';
import { quoteExactInput } from '../quotes.js';
import type { EncodedArbPlan, ExecutionCostsRaw } from '../plan.js';
import { costAdapterForChain, type CostClient, type NativeFeeBreakdown } from './index.js';

const BPS = 10_000n;

export type CostQuoteInput = {
  wrappedNative: Address;
  loanToken: Address;
  venue?: QuoteVenue;
  blockNumber: bigint;
  slippageBps: number;
};

export type EstimatedExecutionCosts = {
  native: NativeFeeBreakdown;
  raw: ExecutionCostsRaw;
};

async function nativeToLoanRaw(client: PublicClient, nativeRaw: bigint, input: CostQuoteInput): Promise<bigint> {
  if (nativeRaw === 0n) return 0n;
  if (input.wrappedNative.toLowerCase() === input.loanToken.toLowerCase()) return nativeRaw;
  if (!input.venue) throw new Error('an executable wrapped-native/loan-token venue is required for cost conversion');
  const quote = await quoteExactInput(client, { venue: input.venue, tokenIn: input.wrappedNative,
    tokenOut: input.loanToken, amountInRaw: nativeRaw, snapshotBlock: input.blockNumber });
  // Costs are rounded upward by applying a buffer to the executable router quote.
  return (quote.amountOutRaw * BigInt(10_000 + input.slippageBps) + BPS - 1n) / BPS;
}

/** Estimates the already encoded transaction and converts every native component via a router quote. */
export async function estimateExecutionCosts(
  client: PublicClient,
  chainId: number,
  executor: Address,
  account: Address,
  plan: EncodedArbPlan,
  quote: CostQuoteInput,
  options: { relayBidNative?: bigint; safetyMarginRaw?: bigint } = {},
  contract?: { abi: Abi; functionName: string },
): Promise<EstimatedExecutionCosts> {
  const decoded = contract ? decodeFunctionData({ abi: contract.abi, data: plan.calldata }) : undefined;
  const tx = { account, address: executor, data: plan.calldata, abi: contract?.abi,
    functionName: contract?.functionName, args: decoded?.args } as const;
  const native = await costAdapterForChain(chainId).estimate(client as unknown as CostClient, tx, options.relayBidNative ?? 0n);
  const [gasCostRaw, l1FeeRaw, relayBidRaw] = await Promise.all([
    nativeToLoanRaw(client, native.gasFeeNative, quote),
    nativeToLoanRaw(client, native.l1DataFeeNative, quote),
    nativeToLoanRaw(client, native.relayBidNative, quote),
  ]);
  return { native, raw: { gasCostRaw, l1FeeRaw, relayBidRaw, safetyMarginRaw: options.safetyMarginRaw ?? 0n } };
}
