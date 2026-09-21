import assert from 'node:assert/strict';
import test from 'node:test';
import { ammOutput, integerSquareRoot, optimalTwoLegArbitrage, type ArbLeg, type V2PoolQuote } from './math.js';

test('ammOutput matches hand-computed Uniswap V2 formula', () => {
  const pool: V2PoolQuote = { reserveIn: 1_000_000n, reserveOut: 1_000_000n, feeBps: 30n };
  assert.equal(ammOutput(10_000n, pool), 9871n);
});

test('ammOutput returns 0 for degenerate inputs', () => {
  const pool: V2PoolQuote = { reserveIn: 1_000n, reserveOut: 1_000n, feeBps: 30n };
  assert.equal(ammOutput(0n, pool), 0n);
  assert.equal(ammOutput(10n, { reserveIn: 0n, reserveOut: 1_000n, feeBps: 30n }), 0n);
});

test('integerSquareRoot floors arbitrary-size values', () => {
  for (const value of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, (1n << 512n) - 1n]) {
    const root = integerSquareRoot(value);
    assert.ok(root * root <= value);
    assert.ok((root + 1n) * (root + 1n) > value);
  }
});

function bruteForce(buy: ArbLeg, sell: ArbLeg, limit: bigint) {
  let loanAmount = 0n;
  let grossProfit = 0n;
  for (let input = 1n; input <= limit; input++) {
    const profit = ammOutput(ammOutput(input, buy), sell) - input;
    if (profit > grossProfit) ({ loanAmount, grossProfit } = { loanAmount: input, grossProfit: profit });
  }
  return { loanAmount, grossProfit, profitable: grossProfit > 0n };
}

test('property: bigint optimizer matches brute force across generated reserves and decimal scales', () => {
  // Deterministic property generation keeps failures reproducible while covering token
  // decimal metadata and magnitudes which cannot be represented safely as numbers.
  let state = 0x6d2b79f5n;
  const random = (maximum: bigint) => {
    state = (state * 1_664_525n + 1_013_904_223n) & 0xffff_ffffn;
    return state % maximum;
  };

  for (const decimals of [6, 8, 18]) {
    const scale = 10n ** BigInt(decimals);
    for (let property = 0; property < 80; property++) {
      // A large common offset exercises > MAX_SAFE_INTEGER reserves. Small output
      // reserves are also generated so EVM division/rounding influences the optimum.
      const magnitude = property % 2 === 0 ? scale : 1n;
      const buy: ArbLeg = {
        reserveIn: (40n + random(160n)) * magnitude,
        reserveOut: (40n + random(220n)) * magnitude,
        feeBps: random(101n),
      };
      const sell: ArbLeg = {
        reserveIn: (40n + random(160n)) * magnitude,
        reserveOut: (40n + random(220n)) * magnitude,
        feeBps: random(101n),
      };
      const limit = 250n;
      const optimized = optimalTwoLegArbitrage(buy, sell, limit);
      const brute = bruteForce(buy, sell, limit);
      assert.equal(optimized.grossProfit, brute.grossProfit,
        `profit mismatch for decimals=${decimals}, buy=${JSON.stringify(buy, (_, v) => typeof v === 'bigint' ? String(v) : v)}`);
      // Several inputs can have the same maximum due to integer rounding, so compare
      // the optimizer's transaction-relevant output rather than its tied input.
      if (optimized.profitable) {
        assert.equal(ammOutput(ammOutput(optimized.loanAmount, buy), sell) - optimized.loanAmount, brute.grossProfit);
      }
      assert.equal(optimized.profitable, brute.profitable);
      if (magnitude === scale && decimals === 18) assert.ok(buy.reserveIn > BigInt(Number.MAX_SAFE_INTEGER));
    }
  }
});

test('matches the real Base fork-test reserves without precision loss', () => {
  const buyLeg: ArbLeg = { reserveIn: 1_176_484_219n, reserveOut: 1_142_301_371_976_125_313n, feeBps: 30n };
  const sellLeg: ArbLeg = { reserveIn: 317_389_073_216_050_948_349n, reserveOut: 781_495_613_336n, feeBps: 30n };
  const result = optimalTwoLegArbitrage(buyLeg, sellLeg);
  assert.ok(result.profitable);
  assert.ok(result.loanAmount > 20_000_000n && result.loanAmount < 5_000_000_000n);
  assert.equal(result.grossProfit, ammOutput(ammOutput(result.loanAmount, buyLeg), sellLeg) - result.loanAmount);
});
