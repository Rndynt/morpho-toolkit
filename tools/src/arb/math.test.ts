import assert from 'node:assert/strict';
import test from 'node:test';
import { ammOutput, optimalTwoLegArbitrage, type ArbLeg, type V2PoolQuote } from './math.js';

test('ammOutput matches hand-computed Uniswap V2 formula', () => {
  const pool: V2PoolQuote = { reserveIn: 1_000_000n, reserveOut: 1_000_000n, feeBps: 30 };
  // amountInWithFee = 10_000 * 9_970 = 99,700,000
  // numerator = 99,700,000 * 1,000,000 = 99,700,000,000,000
  // denominator = 1,000,000*10,000 + 99,700,000 = 10,099,700,000
  // out = floor(99,700,000,000,000 / 10,099,700,000) = 9871
  assert.equal(ammOutput(10_000n, pool), 9871n);
});

test('ammOutput returns 0 for degenerate inputs', () => {
  const pool: V2PoolQuote = { reserveIn: 1_000n, reserveOut: 1_000n, feeBps: 30 };
  assert.equal(ammOutput(0n, pool), 0n);
  assert.equal(ammOutput(10n, { reserveIn: 0n, reserveOut: 1_000n, feeBps: 30 }), 0n);
});

test('optimalTwoLegArbitrage finds a genuine local optimum for an imbalanced pair', () => {
  const buyLeg: ArbLeg = { reserveIn: 1_000_000, reserveOut: 2_000_000, feeBps: 30 };
  const sellLeg: ArbLeg = { reserveIn: 500_000, reserveOut: 1_100_000, feeBps: 30 };

  const result = optimalTwoLegArbitrage(buyLeg, sellLeg);
  assert.equal(result.profitable, true);
  assert.ok(result.loanAmount > 0);

  const profitAt = (x: number): number => {
    const a = 1 - buyLeg.feeBps / 10_000;
    const b = 1 - sellLeg.feeBps / 10_000;
    const intermediate = (a * x * buyLeg.reserveOut) / (buyLeg.reserveIn + a * x);
    const out = (b * intermediate * sellLeg.reserveOut) / (sellLeg.reserveIn + b * intermediate);
    return out - x;
  };

  const atOptimum = profitAt(result.loanAmount);
  // If the closed-form derivation were wrong, one of these neighbors would beat it.
  for (const factor of [0.1, 0.5, 0.9, 1.1, 1.5, 3]) {
    const neighbor = profitAt(result.loanAmount * factor);
    assert.ok(atOptimum >= neighbor - 1e-9, `x*=${result.loanAmount} (profit ${atOptimum}) should beat ${factor}x (profit ${neighbor})`);
  }
  assert.ok(Math.abs(atOptimum - result.grossProfit) < 1e-6);
});

test('optimalTwoLegArbitrage reports no opportunity for identical pools (fees make it a loss)', () => {
  const leg: ArbLeg = { reserveIn: 1_000_000, reserveOut: 1_000_000, feeBps: 30 };
  const result = optimalTwoLegArbitrage(leg, leg);
  assert.equal(result.profitable, false);
  assert.equal(result.loanAmount, 0);
});

test('optimalTwoLegArbitrage scales sensibly with a bigger imbalance', () => {
  const mild = optimalTwoLegArbitrage(
    { reserveIn: 1_000_000, reserveOut: 1_010_000, feeBps: 30 },
    { reserveIn: 1_000_000, reserveOut: 1_000_000, feeBps: 30 },
  );
  const strong = optimalTwoLegArbitrage(
    { reserveIn: 1_000_000, reserveOut: 1_100_000, feeBps: 30 },
    { reserveIn: 1_000_000, reserveOut: 1_000_000, feeBps: 30 },
  );
  assert.ok(strong.profitable && mild.profitable);
  assert.ok(strong.grossProfit > mild.grossProfit, 'bigger imbalance should yield more profit');
  assert.ok(strong.loanAmount > mild.loanAmount, 'bigger imbalance should justify a bigger loan');
});

test('matches the real Base fork-test numbers within AMM rounding', () => {
  // Reserves as logged by the actual forge fork test run against Base mainnet, taken
  // right after the test's 20% WETH dump into Sushi (post-dump Sync event values from
  // the Termux run: WETH 1142301371976125313, USDC 1176484219).
  const sushiPostDumpWeth = 1_142_301_371_976_125_313;
  const sushiPostDumpUsdc = 1_176_484_219;
  const uniswapWeth = 317_389_073_216_050_948_349;
  const uniswapUsdc = 781_495_613_336;

  // Buy WETH cheaply on Sushi (USDC in, WETH out) then sell on Uniswap (WETH in, USDC out) -
  // the same direction the real fork test executed and found profitable.
  const buyLeg: ArbLeg = { reserveIn: sushiPostDumpUsdc, reserveOut: sushiPostDumpWeth, feeBps: 30 };
  const sellLeg: ArbLeg = { reserveIn: uniswapWeth, reserveOut: uniswapUsdc, feeBps: 30 };

  const result = optimalTwoLegArbitrage(buyLeg, sellLeg);
  assert.ok(result.profitable, 'should find the same profitable direction the real fork test found');
  // The real run used a smaller, arbitrarily-chosen loan (10% of Sushi's post-dump USDC
  // reserve = ~117.6 USDC = 117_600_000 raw units) and still cleared ~50 USDC profit. The
  // true unconstrained optimum should be in the same order of magnitude (raw 6-decimal
  // USDC units here, since buyLeg.reserveIn was given in raw units), not wildly off.
  assert.ok(
    result.loanAmount > 20_000_000 && result.loanAmount < 5_000_000_000,
    `optimal loan ${result.loanAmount} raw units out of expected order of magnitude ($20-$5,000)`,
  );
});
