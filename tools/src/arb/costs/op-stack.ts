import { parseAbi, serializeTransaction } from 'viem';
import type { ChainCostAdapter, CostClient, TransactionForCosting } from './types.js';
import { EthereumCostAdapter } from './ethereum.js';

const gasPriceOracle = '0x420000000000000000000000000000000000000F' as const;
const oracleAbi = parseAbi(['function getL1Fee(bytes data) view returns (uint256)']);

/** Base, Optimism and other OP Stack chains expose the official GasPriceOracle. */
export class OpStackCostAdapter implements ChainCostAdapter {
  constructor(private readonly chainId: number) {}
  async estimate(client: CostClient, tx: TransactionForCosting, relayBidNative: bigint) {
    const execution = await new EthereumCostAdapter().estimate(client, tx, relayBidNative);
    // The oracle prices the complete unsigned transaction (not bare executor calldata).
    const serialized = serializeTransaction({ chainId: this.chainId, to: tx.address, data: tx.data,
      gas: execution.gasUnits, maxFeePerGas: execution.baseFeePerGas + execution.priorityFeePerGas,
      maxPriorityFeePerGas: execution.priorityFeePerGas, nonce: 0, value: 0n, type: 'eip1559' });
    const l1DataFeeNative = await client.readContract({ address: gasPriceOracle, abi: oracleAbi,
      functionName: 'getL1Fee', args: [serialized] }) as bigint;
    return { ...execution, l1DataFeeNative, totalNative: execution.totalNative + l1DataFeeNative };
  }
}
