const FEE_DENOMINATOR = 10_000;

export type V2PoolQuote = {
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: number;
};

/** Standard Uniswap-V2-style constant-product quote, fee taken on the input side. */
export function ammOutput(amountIn: bigint, pool: V2PoolQuote): bigint {
  if (amountIn <= 0n || pool.reserveIn <= 0n || pool.reserveOut <= 0n) return 0n;
  const amountInWithFee = amountIn * BigInt(FEE_DENOMINATOR - pool.feeBps);
  const numerator = amountInWithFee * pool.reserveOut;
  const denominator = pool.reserveIn * BigInt(FEE_DENOMINATOR) + amountInWithFee;
  return numerator / denominator;
}

export type ArbLeg = {
  reserveIn: number;
  reserveOut: number;
  feeBps: number;
};

export type OptimalArb = {
  loanAmount: number;
  grossProfit: number;
  profitable: boolean;
};

/**
 * Closed-form optimal input size for a two-leg constant-product arbitrage: borrow
 * `loanAmount` of token T, swap T -> M on buyLeg, swap M -> T on sellLeg.
 *
 * Derivation: let a = 1 - buyLeg.fee, b = 1 - sellLeg.fee. Composing the two constant-
 * product swaps gives finalAmount(x) = A*x / (B + C*x) where
 *   A = a*b*buyLeg.reserveOut*sellLeg.reserveOut
 *   B = buyLeg.reserveIn*sellLeg.reserveIn
 *   C = a*(sellLeg.reserveIn + b*buyLeg.reserveOut)
 * profit(x) = A*x/(B+C*x) - x. d/dx = A*B/(B+C*x)^2 - 1 = 0 => (B+C*x)^2 = A*B
 * => x* = (sqrt(A*B) - B) / C, taking the positive root.
 */
export function optimalTwoLegArbitrage(buyLeg: ArbLeg, sellLeg: ArbLeg): OptimalArb {
  const a = 1 - buyLeg.feeBps / FEE_DENOMINATOR;
  const b = 1 - sellLeg.feeBps / FEE_DENOMINATOR;
  const A = a * b * buyLeg.reserveOut * sellLeg.reserveOut;
  const B = buyLeg.reserveIn * sellLeg.reserveIn;
  const C = a * (sellLeg.reserveIn + b * buyLeg.reserveOut);

  if (!(A > 0) || !(B > 0) || !(C > 0)) return { loanAmount: 0, grossProfit: 0, profitable: false };

  const loanAmount = (Math.sqrt(A * B) - B) / C;
  if (!(loanAmount > 0) || !Number.isFinite(loanAmount)) {
    return { loanAmount: 0, grossProfit: 0, profitable: false };
  }

  const intermediate = (a * loanAmount * buyLeg.reserveOut) / (buyLeg.reserveIn + a * loanAmount);
  const finalAmount = (b * intermediate * sellLeg.reserveOut) / (sellLeg.reserveIn + b * intermediate);
  const grossProfit = finalAmount - loanAmount;

  return { loanAmount, grossProfit, profitable: grossProfit > 0 };
}
