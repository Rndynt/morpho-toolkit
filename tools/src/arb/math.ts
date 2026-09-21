const FEE_DENOMINATOR = 10_000n;

export type V2PoolQuote = {
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: bigint;
};

function validPool(pool: V2PoolQuote): boolean {
  return pool.reserveIn > 0n && pool.reserveOut > 0n && pool.feeBps >= 0n && pool.feeBps < FEE_DENOMINATOR;
}

/** Standard Uniswap-V2-style constant-product quote, fee taken on the input side. */
export function ammOutput(amountIn: bigint, pool: V2PoolQuote): bigint {
  if (amountIn <= 0n || !validPool(pool)) return 0n;
  const amountInWithFee = amountIn * (FEE_DENOMINATOR - pool.feeBps);
  const numerator = amountInWithFee * pool.reserveOut;
  const denominator = pool.reserveIn * FEE_DENOMINATOR + amountInWithFee;
  return numerator / denominator;
}

export type ArbLeg = V2PoolQuote;

export type OptimalArb = {
  loanAmount: bigint;
  grossProfit: bigint;
  profitable: boolean;
};

/** Floor of sqrt(value), without ever converting the value to a floating-point number. */
export function integerSquareRoot(value: bigint): bigint {
  if (value < 0n) throw new RangeError('square root of a negative integer');
  if (value < 2n) return value;

  // This power-of-two seed is above sqrt(value); Newton iteration then decreases.
  let current = 1n << BigInt((value.toString(2).length + 1) >> 1);
  while (true) {
    const next = (current + value / current) >> 1n;
    if (next >= current) return current;
    current = next;
  }
}

function twoLegOutput(amountIn: bigint, buyLeg: ArbLeg, sellLeg: ArbLeg): bigint {
  return ammOutput(ammOutput(amountIn, buyLeg), sellLeg);
}

/**
 * Integer-only closed-form sizing for two constant-product legs. All reserves, fees,
 * inputs, and outputs are raw on-chain units. The rational optimum is calculated with
 * an integer square root and nearby raw-unit candidates are evaluated with the exact
 * (flooring) AMM quote.
 *
 * `maxLoanAmount` is an execution limit, not a display-unit value. Passing it makes a
 * constrained optimum land at the limit when the unconstrained optimum is larger.
 */
export function optimalTwoLegArbitrage(
  buyLeg: ArbLeg,
  sellLeg: ArbLeg,
  maxLoanAmount?: bigint,
): OptimalArb {
  if (!validPool(buyLeg) || !validPool(sellLeg) || maxLoanAmount === 0n) {
    return { loanAmount: 0n, grossProfit: 0n, profitable: false };
  }

  const firstFee = FEE_DENOMINATOR - buyLeg.feeBps;
  const secondFee = FEE_DENOMINATOR - sellLeg.feeBps;
  // Composition is A*x/(B+C*x) before the two EVM division floors.
  const A = firstFee * secondFee * buyLeg.reserveOut * sellLeg.reserveOut;
  const B = FEE_DENOMINATOR * FEE_DENOMINATOR * buyLeg.reserveIn * sellLeg.reserveIn;
  const C = FEE_DENOMINATOR * firstFee * sellLeg.reserveIn
    + firstFee * secondFee * buyLeg.reserveOut;
  const root = integerSquareRoot(A * B);
  if (root <= B) return { loanAmount: 0n, grossProfit: 0n, profitable: false };

  let center = (root - B) / C;
  if (maxLoanAmount !== undefined && center > maxLoanAmount) center = maxLoanAmount;
  if (center <= 0n) return { loanAmount: 0n, grossProfit: 0n, profitable: false };

  // The closed form describes the unrounded curve. Checking adjacent integers chooses
  // correctly when either swap's EVM division moves the discrete maximum by one unit.
  const candidates = new Set<bigint>([center]);
  for (let delta = 1n; delta <= 2n; delta++) {
    if (center > delta) candidates.add(center - delta);
    if (maxLoanAmount === undefined || center + delta <= maxLoanAmount) candidates.add(center + delta);
  }
  if (maxLoanAmount !== undefined) candidates.add(maxLoanAmount);

  let loanAmount = 0n;
  let grossProfit = 0n;
  for (const candidate of candidates) {
    const profit = twoLegOutput(candidate, buyLeg, sellLeg) - candidate;
    if (profit > grossProfit || (profit === grossProfit && profit > 0n && candidate < loanAmount)) {
      loanAmount = candidate;
      grossProfit = profit;
    }
  }
  return { loanAmount, grossProfit, profitable: grossProfit > 0n };
}
