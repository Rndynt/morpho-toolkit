import assert from 'node:assert/strict';
import test from 'node:test';
import { refineOptimalSize } from './optimize.js';
import { ammOutput, optimalTwoLegArbitrage, type ArbLeg } from './math.js';

test('rejects an invalid bracket or iteration budget', async () => {
  await assert.rejects(refineOptimalSize(async () => 0n, 0n, 100n), /above zero/);
  await assert.rejects(refineOptimalSize(async () => 0n, 100n, 1n), /hi >= lo/);
  await assert.rejects(refineOptimalSize(async () => 0n, 1n, 100n, { maxIterations: -1 }), /iteration budget/);
  await assert.rejects(refineOptimalSize(async () => 0n, 1n, 100n, { maxIterations: 1.5 }), /iteration budget/);
});

test('a single-point bracket returns that point without extra evaluation', async () => {
  let calls = 0;
  const result = await refineOptimalSize(async (amount) => { calls++; return amount * 2n; }, 5n, 5n);
  assert.deepEqual(result, { amount: 5n, profit: 10n });
  assert.equal(calls, 1);
});

test('seed points are folded in without being re-evaluated', async () => {
  let calls = 0;
  const evaluate = async (amount: bigint) => { calls++; return -amount; }; // every live call is worse than the seed
  const result = await refineOptimalSize(evaluate, 1n, 1000n, { maxIterations: 0, seed: [{ amount: 42n, profit: 999n }] });
  assert.deepEqual(result, { amount: 42n, profit: 999n });
  assert.equal(calls, 2); // only the two bracket endpoints, since maxIterations is 0
});

test('maxIterations bounds the number of live evaluations', async () => {
  let calls = 0;
  const evaluate = async (amount: bigint) => { calls++; return -((amount - 500_000n) ** 2n); };
  await refineOptimalSize(evaluate, 1n, 1_000_000n, { maxIterations: 3 });
  // 2 endpoints + 3 iterations * 2 evaluations + at most a 3-point final scan
  assert.ok(calls <= 2 + 3 * 2 + 3, `expected a bounded call count, got ${calls}`);
});

test('an increasing-only function within the bracket lands on the upper endpoint', async () => {
  const result = await refineOptimalSize(async (amount) => amount, 1n, 1_000_000n, { maxIterations: 20 });
  assert.equal(result.amount, 1_000_000n);
});

test('matches the closed-form two-leg optimum on realistic 18-decimal reserves', async () => {
  const buyLeg: ArbLeg = { reserveIn: 1_176_484_219n, reserveOut: 1_142_301_371_976_125_313n, feeBps: 30n };
  const sellLeg: ArbLeg = { reserveIn: 317_389_073_216_050_948_349n, reserveOut: 781_495_613_336n, feeBps: 30n };
  const exact = optimalTwoLegArbitrage(buyLeg, sellLeg);
  assert.ok(exact.profitable);
  const evaluate = async (amount: bigint) => ammOutput(ammOutput(amount, buyLeg), sellLeg) - amount;
  const refined = await refineOptimalSize(evaluate, 1n, exact.loanAmount * 4n, { maxIterations: 60 });
  assert.equal(refined.profit, exact.grossProfit);
});

test('a narrow bracket around a known coarse-sweep peak converges within a small iteration budget', async () => {
  // Mirrors the real usage: a wide logarithmic sweep already found the decade the peak
  // sits in, and this only has to refine within that one decade.
  const buyLeg: ArbLeg = { reserveIn: 1_176_484_219n, reserveOut: 1_142_301_371_976_125_313n, feeBps: 30n };
  const sellLeg: ArbLeg = { reserveIn: 317_389_073_216_050_948_349n, reserveOut: 781_495_613_336n, feeBps: 30n };
  const exact = optimalTwoLegArbitrage(buyLeg, sellLeg);
  assert.ok(exact.profitable);
  const lo = exact.loanAmount / 10n > 0n ? exact.loanAmount / 10n : 1n;
  const hi = exact.loanAmount * 10n;
  const evaluate = async (amount: bigint) => ammOutput(ammOutput(amount, buyLeg), sellLeg) - amount;
  const refined = await refineOptimalSize(evaluate, lo, hi, { maxIterations: 16 });
  // A profit curve is locally flat near its peak, so a small position error near the
  // optimum costs far less than proportionally in profit -- ternary search can never
  // overshoot the true maximum, and 16 iterations should land within 0.01% of it here.
  assert.ok(refined.profit <= exact.grossProfit);
  assert.ok((exact.grossProfit - refined.profit) * 10_000n <= exact.grossProfit,
    `refined profit ${refined.profit} too far from exact ${exact.grossProfit}`);
});
