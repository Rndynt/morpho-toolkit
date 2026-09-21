import { parseAbi } from 'viem';
import type { ChainCostAdapter, CostClient, TransactionForCosting } from './types.js';
import { EthereumCostAdapter } from './ethereum.js';

const arbGasInfo = '0x000000000000000000000000000000000000006C' as const;
const arbGasInfoAbi = parseAbi(['function getPricesInWei() view returns (uint256,uint256,uint256,uint256,uint256,uint256)']);

export class ArbitrumCostAdapter implements ChainCostAdapter {
  async estimate(client: CostClient, tx: TransactionForCosting, relayBidNative: bigint) {
    const execution = await new EthereumCostAdapter().estimate(client, tx, relayBidNative);
    const prices = await client.readContract({ address: arbGasInfo, abi: arbGasInfoAbi,
      functionName: 'getPricesInWei' }) as readonly bigint[];
    // ArbGasInfo's second value is the current wei price for one L1 calldata byte.
    const l1PricePerByte = prices[1];
    if (l1PricePerByte === undefined) throw new Error('ArbGasInfo returned an invalid price tuple');
    const bytes = BigInt((tx.data.length - 2) / 2);
    const l1DataFeeNative = bytes * l1PricePerByte;
    return { ...execution, l1DataFeeNative, totalNative: execution.totalNative + l1DataFeeNative };
  }
}
