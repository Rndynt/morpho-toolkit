# Deterministic fork and shadow-mode readiness

## Pinned fork fixtures

`tools/src/arb/fork-fixtures.ts` is the source of truth. Every executable `(chain,
venue)` in `routes.ts` must have exactly one immutable archive block and a reason. The
coverage test derives the expected matrix from the route registry, so adding a venue or
chain without a fixture fails CI. Base venues share block `36,500,000` to make
cross-venue comparisons deterministic. Robinhood Uniswap V2 uses block `51,530,828`, a
known successful Morpho-loan block. A fixture must only be moved in a reviewed change
that records why the old archive state can no longer be replayed.

The deterministic adverse-state suite covers reserve movement after quoting, reduced
Morpho liquidity, a changed pool fee, paused and blacklisted tokens, quote expiry,
the exact deadline boundary, reorgs, execution-gas spikes, and rollup L1-fee spikes.
Every mutation must fail closed; the unmodified pinned state must pass.

## Multi-day shadow run

Use `ShadowRunner.runOnce()` from a scheduler at the intended production cadence for at
least **7 consecutive days**. Its probe must read the candidate, pinned quote, simulation
result and latency, select the next block as hypothetical inclusion, then read that
block to calculate realized output and all costs. `ShadowRunner` only appends mode-0600
JSONL and deliberately has no signer, transaction, relay, or broadcast capability.

Each row records candidate input, an explicit chain/venue segment, quote/block/expiry,
safe-or-unsafe simulation result, hypothetical inclusion block, realized output, loan
principal, safety margin, and total gas + L1 + relay costs.
`measureShadow()` reports false-positive rate, quote-to-inclusion success rate, p50/p95
simulation latency, p50/p95 quote decay, observation interval, and p05/p50/p95 net
profit after subtracting principal, safety margin, and all costs. It computes the same
metrics independently for every chain/venue segment.
Keep raw JSONL as the audit artifact; do not commit it because it can reveal strategy.

## Acceptance criteria before mainnet

Criteria are fixed **before** collecting the run and evaluated by `assessMainnet()`:
the criteria's `requiredSegments` must enumerate the complete production chain/venue
matrix, so an entirely unobserved segment also fails closed.

1. At least 10,000 observations spanning 7 consecutive days.
2. Zero unsafe simulations. Any unsafe result resets the run after remediation.
3. Quote-to-hypothetical-inclusion success rate at least 99%.
4. The p05 net-profit distribution, after execution gas, L1 data fee, relay bid and
   safety margin, is strictly positive and above the configured production profit floor.
5. Results are segmented by chain and venue as well as assessed globally; every segment
   must pass. Missing realized output counts as a failed inclusion/false positive, not
   as a discarded sample.

Mainnet broadcast remains disabled until a dated report captures the configuration,
fixture revision, observation interval, raw-log digest, metric distribution, and an
`accepted: true` result. Passing averages cannot override any criterion above.
