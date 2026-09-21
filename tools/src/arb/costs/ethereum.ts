import type { ChainCostAdapter, CostClient, NativeFeeBreakdown, TransactionForCosting } from './types.js';

export class EthereumCostAdapter implements ChainCostAdapter {
  async estimate(client: CostClient, tx: TransactionForCosting, relayBidNative: bigint): Promise<NativeFeeBreakdown> {
    if (!tx.abi || !tx.functionName || !tx.args) throw new Error('contract ABI and exact transaction parameters are required for gas estimation');
    const { data: _calldata, ...contractRequest } = tx;
    const [gasUnits, block, priorityFeePerGas] = await Promise.all([
      client.estimateContractGas(contractRequest as TransactionForCosting),
      client.getBlock({ blockTag: 'latest' }),
      client.estimateMaxPriorityFeePerGas?.() ?? Promise.resolve(0n),
    ]);
    if (block.baseFeePerGas == null) throw new Error('latest block has no EIP-1559 base fee');
    // Use 2x the current base fee so the transaction remains marketable if the next
    // block is full. The priority fee and explicit private-builder bid are separate.
    const baseFeePerGas = block.baseFeePerGas * 2n;
    const gasFeeNative = gasUnits * (baseFeePerGas + priorityFeePerGas);
    return { gasUnits, baseFeePerGas, priorityFeePerGas, gasFeeNative, l1DataFeeNative: 0n,
      relayBidNative, totalNative: gasFeeNative + relayBidNative };
  }
}
