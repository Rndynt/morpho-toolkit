export type SizeEvaluation = { amount: bigint; profit: bigint };

export type RefineOptions = {
  /** Upper bound on ternary-search iterations (2 evaluations each, plus a small final
   * scan). Bounds the number of on-chain quote calls; does not guarantee convergence
   * for a bracket much wider than `1.5 ** maxIterations`. Default 14 (~2500x shrink). */
  maxIterations?: number;
  /** Already-known (amount, profit) pairs -- e.g. the coarse sweep points that defined
   * this bracket -- folded into the result without re-evaluating them. */
  seed?: readonly SizeEvaluation[];
};

/**
 * Refines the location of a local profit maximum over the integer bracket [lo, hi] via
 * bounded ternary search, for round trips that have no closed-form optimum (a
 * bonding-curve leg, a concentrated-liquidity quoter crossing ticks, or any other venue
 * `math.ts`'s constant-product `optimalTwoLegArbitrage` cannot model).
 *
 * `evaluate` must be a pure function of `amount` for a fixed on-chain snapshot (e.g. a
 * pinned block) -- calls are cached and may be issued out of order or in parallel pairs.
 * It should already fold reverts / zero-output legs into a real (typically very
 * negative) profit value; this function never sees `null`.
 *
 * Ternary search assumes `evaluate` is unimodal (rises then falls) across the bracket.
 * That holds for a genuine two-leg AMM round trip in the continuous case, but EVM
 * integer rounding, bonding-curve steps, or a V4 tick crossing can introduce small
 * non-monotonic bumps -- callers should pick a bracket already known to contain the
 * peak (e.g. the two neighbors of the best point from a wider coarse sweep) rather than
 * relying on this to search a wide, unexplored range from scratch.
 */
export async function refineOptimalSize(
  evaluate: (amount: bigint) => Promise<bigint>,
  lo: bigint,
  hi: bigint,
  options: RefineOptions = {},
): Promise<SizeEvaluation> {
  if (lo <= 0n) throw new Error('search bracket must start above zero');
  if (hi < lo) throw new Error('search bracket must have hi >= lo');
  const maxIterations = options.maxIterations ?? 14;
  if (!Number.isInteger(maxIterations) || maxIterations < 0) throw new Error('invalid iteration budget');

  const cache = new Map<string, bigint>();
  const at = async (amount: bigint): Promise<bigint> => {
    const key = amount.toString();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const profit = await evaluate(amount);
    cache.set(key, profit);
    return profit;
  };

  let best: SizeEvaluation | undefined;
  const consider = (amount: bigint, profit: bigint) => {
    if (best === undefined || profit > best.profit) best = { amount, profit };
  };
  for (const s of options.seed ?? []) consider(s.amount, s.profit);

  // The bracket endpoints are always evaluated so a result is guaranteed even with
  // maxIterations 0 or a bracket too wide to fully collapse in the given budget.
  consider(lo, await at(lo));
  if (hi !== lo) consider(hi, await at(hi));

  let searchLo = lo, searchHi = hi;
  for (let i = 0; i < maxIterations && searchHi - searchLo > 2n; i++) {
    const third = (searchHi - searchLo) / 3n;
    const m1 = searchLo + third;
    const m2 = searchHi - third;
    const [p1, p2] = await Promise.all([at(m1), at(m2)]);
    consider(m1, p1);
    consider(m2, p2);
    if (p1 < p2) searchLo = m1; else searchHi = m2;
  }
  // Only safe to exhaustively scan what the loop has already proven is a small range
  // (its natural exit is width <= 2); the cap guards against maxIterations being too
  // small to shrink a wide caller-supplied bracket.
  if (searchHi - searchLo <= 8n) {
    for (let amount = searchLo; amount <= searchHi; amount++) consider(amount, await at(amount));
  }
  return best!;
}
