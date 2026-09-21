import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address } from '../config/registry.js';
import { AerodromeConcentratedAdapter, BalancerVaultAdapter, CurveStableAdapter, UniswapV3Adapter, venuePoolId } from './venues/adapters.js';
import { buildMarketGraph, findCycles, quoteAndPruneCycles } from './venues/graph.js';
import type { Pool, VenueAdapter, VenueFamily, VenueRpc } from './venues/types.js';

const EXECUTOR = '0x0000000000000000000000000000000000000010' as Address;
const TARGET = '0x0000000000000000000000000000000000000020' as Address;
const A = '0x000000000000000000000000000000000000000a' as Address;
const B = '0x000000000000000000000000000000000000000b' as Address;
const C = '0x000000000000000000000000000000000000000c' as Address;
const rpc: VenueRpc = { readContract: async () => 0n, estimateGas: async () => 123_456n };

function pool(family: VenueFamily, address: Address, token0 = A, token1 = B, data: Pool['data'] = {}): Pool {
  const suffix = family === 'uniswap-v3' ? String(data.feeTier ?? 30)
    : family === 'aerodrome-cl' ? String(data.tickSpacing)
    : family === 'balancer-vault' ? String(data.vaultPoolId) : '';
  return { family, venue: family, address, token0, token1, liquidity: 1_000_000n, fee: 30, data,
    id: venuePoolId(family, address, suffix) } as Pool;
}

test('all venue adapters produce guarded typed calldata', async () => {
  const vaultId = `0x${'ab'.repeat(32)}`;
  const cases: Array<{ adapter: VenueAdapter; pool: Pool }> = [
    { adapter: new UniswapV3Adapter({ rpc, executor: EXECUTOR, target: TARGET, pools: async () => [], quote: async () => 2n }), pool: pool('uniswap-v3', '0x0000000000000000000000000000000000000031', A, B, { feeTier: 500 }) },
    { adapter: new AerodromeConcentratedAdapter({ rpc, executor: EXECUTOR, target: TARGET, pools: async () => [], quote: async () => 2n }), pool: pool('aerodrome-cl', '0x0000000000000000000000000000000000000032', A, B, { tickSpacing: 100 }) },
    { adapter: new CurveStableAdapter({ rpc, executor: EXECUTOR, target: TARGET, pools: async () => [], quote: async () => 2n }), pool: pool('curve-stable', '0x0000000000000000000000000000000000000033') },
    { adapter: new BalancerVaultAdapter({ rpc, executor: EXECUTOR, target: TARGET, pools: async () => [], quote: async () => 2n }), pool: pool('balancer-vault', '0x0000000000000000000000000000000000000034', A, B, { vaultPoolId: vaultId }) },
  ];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  for (const entry of cases) {
    await entry.adapter.validatePool(entry.pool);
    const call = entry.adapter.encodeSwap({ pool: entry.pool, tokenIn: A, tokenOut: B, amountIn: 10n, minAmountOut: 9n, blockNumber: 1n, recipient: EXECUTOR, deadline });
    assert.equal(call.selector, call.calldata.slice(0, 10));
    assert.equal(call.approval.token.toLowerCase(), A);
    assert.equal(call.approval.spender, TARGET);
    assert.equal(call.approval.amount, 10n);
    assert.equal(call.tokenDeltas[1].minimum, 9n);
    assert.equal(await entry.adapter.estimateGas(call), 123_456n);
    assert.throws(() => entry.adapter.encodeSwap({ pool: entry.pool, tokenIn: A, tokenOut: B, amountIn: 10n, minAmountOut: 9n, blockNumber: 1n, recipient: TARGET, deadline }), /recipient/);
  }
});

test('token-pool graph finds two-leg and triangular cycles and prunes by constraints', async () => {
  const adapter = new UniswapV3Adapter({ rpc, executor: EXECUTOR, target: TARGET, pools: async () => [], quote: async (request) => request.amountIn + 10n });
  const ab = pool('uniswap-v3', '0x0000000000000000000000000000000000000041', A, B, { feeTier: 500 });
  const ba = pool('uniswap-v3', '0x0000000000000000000000000000000000000042', A, B, { feeTier: 3000 });
  const bc = pool('uniswap-v3', '0x0000000000000000000000000000000000000043', B, C, { feeTier: 500 });
  const ca = pool('uniswap-v3', '0x0000000000000000000000000000000000000044', C, A, { feeTier: 500 });
  const graph = buildMarketGraph([ab, ba, bc, ca].map((market) => ({ pool: market, adapter })));
  const cycles = findCycles(graph, [A], 3);
  assert.ok(cycles.some((cycle) => cycle.edges.length === 2));
  assert.ok(cycles.some((cycle) => cycle.edges.length === 3));
  assert.ok(cycles.every((cycle) => new Set(cycle.edges.map((edge) => edge.pool.id)).size === cycle.edges.length));
  const quoted = await quoteAndPruneCycles(cycles, { amountIn: 100n, blockNumber: 1n, minimumLiquidity: 100n, maximumGas: 200_000n, loanInventory: { [A.toLowerCase()]: 100n }, estimateGas: async () => 150_000n });
  assert.ok(quoted.length > 0);
  assert.ok(quoted.every((candidate) => candidate.profit > 0n));
});
