import { encodeFunctionData, getAddress, keccak256, parseAbi, toBytes, toFunctionSelector, type Abi, type Hex } from 'viem';
import type { Address } from '../../config/registry.js';
import type { ExactInputRequest, Pool, PoolDiscovery, SwapRequest, TypedSwapCall, VenueAdapter, VenueFamily, VenueRpc } from './types.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_DEADLINE_WINDOW = 300n;

export type PoolSource = (request: PoolDiscovery) => Promise<Pool[]>;
export type QuoteSource = (request: ExactInputRequest) => Promise<bigint>;

type AdapterConfig = {
  rpc: VenueRpc;
  executor: Address;
  target: Address;
  pools: PoolSource;
  quote: QuoteSource;
};

function same(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }
function selector(calldata: Hex): Hex { return calldata.slice(0, 10) as Hex; }
function poolId(family: VenueFamily, address: Address, suffix = ''): Hex {
  return keccak256(toBytes(`${family}:${address.toLowerCase()}:${suffix}`));
}

abstract class BaseAdapter implements VenueAdapter {
  abstract readonly family: VenueFamily;
  protected abstract readonly abi: Abi;
  protected abstract readonly functionName: string;
  constructor(protected readonly config: AdapterConfig) {}

  async discoverPools(request: PoolDiscovery): Promise<Pool[]> {
    const pools = await this.config.pools(request);
    const valid: Pool[] = [];
    for (const pool of pools) {
      if (!request.tokens.some((t) => same(t, pool.token0)) || !request.tokens.some((t) => same(t, pool.token1))) continue;
      await this.validatePool(pool);
      valid.push(pool);
    }
    return valid;
  }

  async quoteExactInput(request: ExactInputRequest): Promise<bigint> {
    this.validateRequest(request);
    const amount = await this.config.quote(request);
    if (amount <= 0n) throw new Error(`${this.family}: quote is not executable`);
    return amount;
  }

  protected validateRequest(request: ExactInputRequest): void {
    if (request.amountIn <= 0n) throw new Error(`${this.family}: amountIn must be positive`);
    if (request.pool.venue !== this.family) throw new Error(`${this.family}: pool venue mismatch`);
    const forward = same(request.tokenIn, request.pool.token0) && same(request.tokenOut, request.pool.token1);
    const reverse = same(request.tokenIn, request.pool.token1) && same(request.tokenOut, request.pool.token0);
    if (!forward && !reverse) throw new Error(`${this.family}: token pair does not belong to pool`);
  }

  protected checkedCall(request: SwapRequest, calldata: Hex): TypedSwapCall {
    this.validateRequest(request);
    if (same(request.recipient, ZERO) || !same(request.recipient, this.config.executor)) {
      throw new Error(`${this.family}: recipient must be the executor`);
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (request.deadline < now || request.deadline > now + MAX_DEADLINE_WINDOW) throw new Error(`${this.family}: invalid deadline`);
    const item = this.abi.find((entry) => entry.type === 'function' && entry.name === this.functionName);
    if (!item || item.type !== 'function') throw new Error(`${this.family}: missing typed ABI`);
    const expected = toFunctionSelector(item);
    const actual = selector(calldata);
    if (actual !== expected) throw new Error(`${this.family}: selector mismatch`);
    return {
      venue: this.family, poolId: request.pool.id, target: this.config.target, selector: actual, calldata,
      approval: { token: getAddress(request.tokenIn) as Address, spender: this.config.target, amount: request.amountIn },
      tokenDeltas: [
        { token: getAddress(request.tokenIn) as Address, direction: 'decrease', maximum: request.amountIn },
        { token: getAddress(request.tokenOut) as Address, direction: 'increase', minimum: request.minAmountOut },
      ],
      recipient: getAddress(request.recipient) as Address, deadline: request.deadline,
    };
  }

  async estimateGas(call: TypedSwapCall): Promise<bigint> {
    if (call.venue !== this.family || call.target.toLowerCase() !== this.config.target.toLowerCase()) throw new Error('call does not belong to adapter');
    if (selector(call.calldata) !== call.selector) throw new Error('typed call selector mismatch');
    return this.config.rpc.estimateGas({ account: this.config.executor, to: call.target, data: call.calldata });
  }

  async validatePool(pool: Pool): Promise<void> {
    if (pool.venue !== this.family || same(pool.address, ZERO) || same(pool.token0, pool.token1) || pool.liquidity <= 0n) throw new Error(`${this.family}: invalid pool`);
    const expected = poolId(this.family, pool.address, this.identitySuffix(pool));
    if (pool.id !== expected) throw new Error(`${this.family}: invalid pool identifier`);
  }

  protected identitySuffix(_pool: Pool): string { return ''; }
  abstract encodeSwap(request: SwapRequest): TypedSwapCall;
}

const clAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut)']);

export class UniswapV3Adapter extends BaseAdapter {
  readonly family = 'uniswap-v3' as const;
  protected readonly abi = clAbi; protected readonly functionName = 'exactInputSingle';
  protected identitySuffix(pool: Pool): string { return String(pool.data.feeTier ?? pool.fee); }
  encodeSwap(r: SwapRequest): TypedSwapCall {
    const calldata = encodeFunctionData({ abi: clAbi, functionName: 'exactInputSingle', args: [{ tokenIn: r.tokenIn, tokenOut: r.tokenOut, fee: Number(r.pool.data.feeTier ?? r.pool.fee), recipient: r.recipient, deadline: r.deadline, amountIn: r.amountIn, amountOutMinimum: r.minAmountOut, sqrtPriceLimitX96: 0n }] });
    return this.checkedCall(r, calldata);
  }
}

export class AerodromeConcentratedAdapter extends BaseAdapter {
  readonly family = 'aerodrome-cl' as const;
  protected readonly abi = clAbi; protected readonly functionName = 'exactInputSingle';
  protected identitySuffix(pool: Pool): string { return String(pool.data.tickSpacing); }
  encodeSwap(r: SwapRequest): TypedSwapCall {
    if (!Number.isInteger(Number(r.pool.data.tickSpacing))) throw new Error('aerodrome-cl: tick spacing missing');
    const calldata = encodeFunctionData({ abi: clAbi, functionName: 'exactInputSingle', args: [{ tokenIn: r.tokenIn, tokenOut: r.tokenOut, fee: r.pool.fee, recipient: r.recipient, deadline: r.deadline, amountIn: r.amountIn, amountOutMinimum: r.minAmountOut, sqrtPriceLimitX96: 0n }] });
    return this.checkedCall(r, calldata);
  }
}

const curveAbi = parseAbi(['function exchange(int128 i,int128 j,uint256 dx,uint256 minDy,address receiver) returns (uint256)']);
export class CurveStableAdapter extends BaseAdapter {
  readonly family = 'curve-stable' as const;
  protected readonly abi = curveAbi; protected readonly functionName = 'exchange';
  encodeSwap(r: SwapRequest): TypedSwapCall {
    const forward = same(r.tokenIn, r.pool.token0);
    const calldata = encodeFunctionData({ abi: curveAbi, functionName: 'exchange', args: [forward ? 0n : 1n, forward ? 1n : 0n, r.amountIn, r.minAmountOut, r.recipient] });
    return this.checkedCall(r, calldata);
  }
}

const vaultAbi = parseAbi(['function swap((bytes32 poolId,uint8 kind,address assetIn,address assetOut,uint256 amount,bytes userData) singleSwap,(address sender,bool fromInternalBalance,address payable recipient,bool toInternalBalance) funds,uint256 limit,uint256 deadline) payable returns (uint256)']);
export class BalancerVaultAdapter extends BaseAdapter {
  readonly family = 'balancer-vault' as const;
  protected readonly abi = vaultAbi; protected readonly functionName = 'swap';
  protected identitySuffix(pool: Pool): string { return String(pool.data.vaultPoolId); }
  encodeSwap(r: SwapRequest): TypedSwapCall {
    const vaultPoolId = r.pool.data.vaultPoolId as Hex;
    if (!vaultPoolId || vaultPoolId.length !== 66) throw new Error('balancer-vault: pool id missing');
    const calldata = encodeFunctionData({ abi: vaultAbi, functionName: 'swap', args: [{ poolId: vaultPoolId, kind: 0, assetIn: r.tokenIn, assetOut: r.tokenOut, amount: r.amountIn, userData: '0x' }, { sender: r.recipient, fromInternalBalance: false, recipient: r.recipient, toInternalBalance: false }, r.minAmountOut, r.deadline] });
    return this.checkedCall(r, calldata);
  }
}

export const venuePoolId = poolId;
