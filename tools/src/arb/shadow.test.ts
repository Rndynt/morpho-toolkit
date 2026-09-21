import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessMainnet, measureShadow, ShadowRunner, ShadowStore, type ShadowRecord } from './shadow.js';

const record = (id: string, realized: string | null, safe = true): ShadowRecord => ({ schemaVersion: 1, candidateId: id, observedAt: '2026-09-21T00:00:00.000Z', chainId: 8453, candidate: { route: 'a-b' }, quote: { blockNumber: '36500000', amountOutRaw: '120', expiresAt: '2026-09-21T00:01:00.000Z' }, simulation: { safe, latencyMs: 20 }, hypotheticalInclusionBlock: '36500001', realizedOutputRaw: realized, totalCostsRaw: '100' });

test('shadow metrics include false positives, latency, decay and profit after all costs', () => {
  const metrics = measureShadow([record('a', '115'), record('b', null), record('c', '90', false)]);
  assert.equal(metrics.samples, 3); assert.equal(metrics.unsafeSimulations, 1);
  assert.equal(metrics.falsePositiveRate, 1 / 3); assert.equal(metrics.quoteToInclusionSuccessRate, 2 / 3);
  assert.equal(metrics.latencyMs.p95, 20); assert.ok(metrics.quoteDecayBps.p95 > 0); assert.equal(metrics.netProfitRaw.p05, -10n);
  assert.equal(assessMainnet(metrics, { minimumSamples: 3, minimumSuccessRate: .9, minimumP05NetProfitRaw: 1n }).accepted, false);
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
