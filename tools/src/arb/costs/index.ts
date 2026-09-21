import type { ChainCostAdapter } from './types.js';
import { EthereumCostAdapter } from './ethereum.js';
import { OpStackCostAdapter } from './op-stack.js';
import { ArbitrumCostAdapter } from './arbitrum.js';

export * from './types.js';

export function costAdapterForChain(chainId: number): ChainCostAdapter {
  if (chainId === 1) return new EthereumCostAdapter();
  if (chainId === 10 || chainId === 8453) return new OpStackCostAdapter(chainId);
  if (chainId === 42161) return new ArbitrumCostAdapter();
  throw new Error(`no official execution-cost oracle adapter configured for chain ${chainId}`);
}
