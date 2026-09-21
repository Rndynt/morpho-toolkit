import assert from 'node:assert/strict';
import test from 'node:test';

type State = { reserve: bigint; morpho: bigint; feeBps: bigint; paused: boolean; blacklisted: boolean; quoteExpires: bigint; deadline: bigint; canonical: boolean; gas: bigint; l1Fee: bigint };
const evaluate = (s: State, now = 100n): string | null => {
  if (!s.canonical) return 'reorg';
  if (s.paused || s.blacklisted) return 'token-policy';
  if (now > s.quoteExpires) return 'quote-expired';
  if (now >= s.deadline) return 'deadline';
  if (s.morpho < 100n) return 'morpho-liquidity';
  if (s.reserve < 1_000n) return 'reserve-changed';
  if (s.feeBps !== 30n) return 'pool-fee-changed';
  if (s.gas > 20n) return 'gas-spike';
  if (s.l1Fee > 10n) return 'l1-fee-spike';
  return null;
};
const base: State = { reserve: 1_000n, morpho: 100n, feeBps: 30n, paused: false, blacklisted: false, quoteExpires: 101n, deadline: 101n, canonical: true, gas: 20n, l1Fee: 10n };

test('deterministic adverse-state matrix fails closed at the pinned snapshot boundary', () => {
  const cases: Array<[string, Partial<State>, bigint?]> = [
    ['reserve-changed', { reserve: 999n }], ['morpho-liquidity', { morpho: 99n }], ['pool-fee-changed', { feeBps: 31n }],
    ['token-policy', { paused: true }], ['token-policy', { blacklisted: true }], ['quote-expired', {}, 102n],
    ['deadline', {}, 101n], ['reorg', { canonical: false }], ['gas-spike', { gas: 21n }], ['l1-fee-spike', { l1Fee: 11n }],
  ];
  for (const [expected, mutation, now] of cases) assert.equal(evaluate({ ...base, ...mutation }, now), expected);
  assert.equal(evaluate(base, 100n), null, 'deadline and quote expiry are inclusive until the preceding second');
});
