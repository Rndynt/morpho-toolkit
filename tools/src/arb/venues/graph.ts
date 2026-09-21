import type { Address } from '../../config/registry.js';
import type { Pool, VenueAdapter } from './types.js';

export type MarketEdge = { pool: Pool; adapter: VenueAdapter; tokenIn: Address; tokenOut: Address };
export type MarketGraph = Map<string, MarketEdge[]>;
export type Cycle = { loanToken: Address; edges: MarketEdge[] };
export type CycleQuote = { cycle: Cycle; amounts: bigint[]; gas: bigint; profit: bigint };

const key = (address: Address) => address.toLowerCase();

export function buildMarketGraph(entries: Array<{ pool: Pool; adapter: VenueAdapter }>): MarketGraph {
  const graph: MarketGraph = new Map();
  for (const { pool, adapter } of entries) {
    const directions: MarketEdge[] = [
      { pool, adapter, tokenIn: pool.token0, tokenOut: pool.token1 },
      { pool, adapter, tokenIn: pool.token1, tokenOut: pool.token0 },
    ];
    for (const edge of directions) graph.set(key(edge.tokenIn), [...(graph.get(key(edge.tokenIn)) ?? []), edge]);
  }
  return graph;
}

/** Finds simple two-leg and triangular token cycles. maxHops is intentionally capped at
 * three: this executor supports atomic arbitrage, not an unconstrained path search. */
export function findCycles(graph: MarketGraph, loanTokens: readonly Address[], maxHops = 3): Cycle[] {
  if (!Number.isInteger(maxHops) || maxHops < 2 || maxHops > 3) throw new Error('maxHops must be 2 or 3');
  const cycles: Cycle[] = [];
  for (const loanToken of loanTokens) {
    const visit = (token: Address, edges: MarketEdge[], visited: Set<string>): void => {
      if (edges.length >= maxHops) return;
      for (const edge of graph.get(key(token)) ?? []) {
        // Reusing the exact pool in a round trip is economically nonsensical and can
        // also make identity-only route checks misleading.
        if (edges.some((old) => old.pool.id === edge.pool.id)) continue;
        if (key(edge.tokenOut) === key(loanToken)) {
          if (edges.length + 1 >= 2) cycles.push({ loanToken, edges: [...edges, edge] });
          continue;
        }
        if (visited.has(key(edge.tokenOut))) continue;
        visit(edge.tokenOut, [...edges, edge], new Set([...visited, key(edge.tokenOut)]));
      }
    };
    visit(loanToken, [], new Set([key(loanToken)]));
  }
  return cycles;
}

export async function quoteAndPruneCycles(cycles: readonly Cycle[], options: {
  amountIn: bigint; blockNumber: bigint; minimumLiquidity: bigint; maximumGas: bigint;
  loanInventory: Readonly<Record<string, bigint>>;
  estimateGas: (cycle: Cycle) => Promise<bigint>;
}): Promise<CycleQuote[]> {
  const output: CycleQuote[] = [];
  for (const cycle of cycles) {
    if (cycle.edges.some((edge) => edge.pool.liquidity < options.minimumLiquidity)) continue;
    if ((options.loanInventory[key(cycle.loanToken)] ?? 0n) < options.amountIn) continue;
    try {
      const amounts = [options.amountIn];
      for (const edge of cycle.edges) amounts.push(await edge.adapter.quoteExactInput({ pool: edge.pool, tokenIn: edge.tokenIn, tokenOut: edge.tokenOut, amountIn: amounts.at(-1)!, blockNumber: options.blockNumber }));
      const gas = await options.estimateGas(cycle);
      if (gas > options.maximumGas || amounts.at(-1)! <= options.amountIn) continue;
      output.push({ cycle, amounts, gas, profit: amounts.at(-1)! - options.amountIn });
    } catch { /* A reverting/non-positive quote is non-executable and therefore pruned. */ }
  }
  return output.sort((a, b) => a.profit === b.profit ? 0 : a.profit > b.profit ? -1 : 1);
}
