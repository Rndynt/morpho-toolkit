import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessMainnet, measureShadow, ShadowRunner, ShadowStore, type ShadowRecord } from './shadow.js';

const record = (id: string, realized: string | null, safe = true, venue = 'Uniswap V2', observedAt = '2026-09-21T00:00:00.000Z'): ShadowRecord => ({ schemaVersion: 1, candidateId: id, observedAt, chainId: 8453, venue, candidate: { route: 'a-b' }, quote: { blockNumber: '36500000', amountOutRaw: '120', expiresAt: '2026-09-21T00:01:00.000Z' }, simulation: { safe, latencyMs: 20 }, hypotheticalInclusionBlock: '36500001', realizedOutputRaw: realized, loanPrincipalRaw: '100', safetyMarginRaw: '2', totalCostsRaw: '10' });

test('shadow metrics include false positives, latency, decay and profit after all costs', () => {
  const metrics = measureShadow([record('a', '115'), record('b', null), record('c', '90', false)]);
  assert.equal(metrics.samples, 3); assert.equal(metrics.unsafeSimulations, 1);
  assert.equal(metrics.falsePositiveRate, 1 / 3); assert.equal(metrics.quoteToInclusionSuccessRate, 2 / 3);
  assert.equal(metrics.latencyMs.p95, 20); assert.ok(metrics.quoteDecayBps.p95 > 0); assert.equal(metrics.netProfitRaw.p05, -22n);
  assert.equal(assessMainnet(metrics, { minimumSamples: 3, minimumSuccessRate: .9, minimumP05NetProfitRaw: 1n, requiredSegments: [{ chainId: 8453, venue: 'Uniswap V2' }] }).accepted, false);
});

test('readiness requires seven days and every chain/venue segment to pass independently', () => {
  const start = '2026-09-01T00:00:00.000Z';
  const end = '2026-09-08T00:00:00.000Z';
  const healthy = [record('a', '120', true, 'Uniswap V2', start), record('b', '120', true, 'Uniswap V2', end)];
  const criteria = { minimumSamples: 2, minimumSuccessRate: 1, minimumP05NetProfitRaw: 1n, requiredSegments: [{ chainId: 8453, venue: 'Uniswap V2' }] };
  assert.equal(assessMainnet(measureShadow(healthy), criteria).accepted, true);
  assert.equal(assessMainnet(measureShadow(healthy.map((r) => ({ ...r, observedAt: start }))), criteria).accepted, false);

  const maskedVenue = [...healthy, record('c', '120', true, 'Sushi V2', start)];
  const assessment = assessMainnet(measureShadow(maskedVenue), { ...criteria, minimumSamples: 1 });
  assert.equal(assessment.accepted, false);
  assert.ok(assessment.failures.some((failure) => failure.includes('Sushi V2 observation span')));

  const missingVenue = assessMainnet(measureShadow(healthy), { ...criteria, requiredSegments: [...criteria.requiredSegments, { chainId: 8453, venue: 'Sushi V2' }] });
  assert.ok(missingVenue.failures.some((failure) => failure.includes('missing required chain 8453 venue Sushi V2')));
});

test('net profit subtracts principal, costs, and safety margin', () => {
  const metrics = measureShadow([record('break-even-before-costs', '100')]);
  assert.equal(metrics.netProfitRaw.p05, -12n);
  assert.equal(metrics.falsePositiveRate, 1);
});

test('runner persists the complete observation without exposing broadcast', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'morpho-shadow-')), 'observations.jsonl');
  const source = record('candidate-1', '115');
  const { schemaVersion: _schema, observedAt: _time, ...observation } = source;
  const runner = new ShadowRunner({ observe: async () => observation }, new ShadowStore(path), () => new Date('2026-09-21T00:00:00Z'));
  await runner.runOnce();
  const saved = JSON.parse((await readFile(path, 'utf8')).trim()) as ShadowRecord;
  assert.deepEqual(saved, source);
  assert.equal('broadcast' in runner, false);
});
