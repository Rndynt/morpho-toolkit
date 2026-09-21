import type { Address } from '../../config/registry.js';

export type TransactionForCosting = {
  account: Address;
  address: Address;
  data: `0x${string}`;
  abi?: readonly unknown[];
  functionName?: string;
  args?: readonly unknown[];
};

export type NativeFeeBreakdown = {
  gasUnits: bigint;
  baseFeePerGas: bigint;
  priorityFeePerGas: bigint;
  gasFeeNative: bigint;
  l1DataFeeNative: bigint;
  relayBidNative: bigint;
  totalNative: bigint;
};

export interface CostClient {
  estimateContractGas(args: TransactionForCosting): Promise<bigint>;
  getBlock(args?: { blockTag?: 'latest' }): Promise<{ baseFeePerGas?: bigint | null }>;
  estimateMaxPriorityFeePerGas?(): Promise<bigint>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

export interface ChainCostAdapter {
  estimate(client: CostClient, tx: TransactionForCosting, relayBidNative: bigint): Promise<NativeFeeBreakdown>;
}
