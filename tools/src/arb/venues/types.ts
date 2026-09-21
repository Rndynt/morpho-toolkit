import type { Address } from '../../config/registry.js';
import type { Hex } from 'viem';

export type VenueFamily = 'uniswap-v3' | 'aerodrome-cl' | 'curve-stable' | 'balancer-vault';

export type Pool = {
  venue: VenueFamily;
  id: Hex;
  address: Address;
  token0: Address;
  token1: Address;
  liquidity: bigint;
  fee: number;
  /** Venue-specific immutable data (fee tier, tick spacing, indexes or Balancer pool id). */
  data: Readonly<Record<string, bigint | number | string>>;
};

export type PoolDiscovery = { tokens: readonly Address[]; blockNumber: bigint };
export type ExactInputRequest = {
  pool: Pool;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  blockNumber: bigint;
};
export type SwapRequest = ExactInputRequest & {
  recipient: Address;
  minAmountOut: bigint;
  deadline: bigint;
};

/** A route call is deliberately not just target+bytes: every permission and expected
 * balance movement needed by the executor travels with the encoded call. */
export type TypedSwapCall = {
  venue: VenueFamily;
  poolId: Hex;
  target: Address;
  selector: Hex;
  calldata: Hex;
  approval: { token: Address; spender: Address; amount: bigint };
  tokenDeltas: readonly [
    { token: Address; direction: 'decrease'; maximum: bigint },
    { token: Address; direction: 'increase'; minimum: bigint },
  ];
  recipient: Address;
  deadline: bigint;
};

export interface VenueRpc {
  readContract(args: Record<string, unknown>): Promise<unknown>;
  estimateGas(args: { account: Address; to: Address; data: Hex }): Promise<bigint>;
}

export interface VenueAdapter {
  readonly family: VenueFamily;
  discoverPools(request: PoolDiscovery): Promise<Pool[]>;
  quoteExactInput(request: ExactInputRequest): Promise<bigint>;
  encodeSwap(request: SwapRequest): TypedSwapCall;
  estimateGas(call: TypedSwapCall): Promise<bigint>;
  validatePool(pool: Pool): Promise<void>;
}
