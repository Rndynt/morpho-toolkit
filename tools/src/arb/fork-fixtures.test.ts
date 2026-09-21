import assert from 'node:assert/strict';
import test from 'node:test';
import { forkFixtures } from './fork-fixtures.js';
import { solidlyPairs, v2Pairs } from './routes.js';

test('every executable chain/venue has one documented pinned fork fixture', () => {
  const supported = new Set<string>();
  for (const pair of v2Pairs) for (const router of pair.routers) {
    if (router.feeModel.kind !== 'unsupported') supported.add(`${pair.chain}:v2:${router.label}`);
  }
  for (const pair of solidlyPairs) supported.add(`${pair.chain}:aerodrome:${pair.pool.label}`);
  const fixtures = new Set(forkFixtures.map((f) => `${f.chain}:${f.kind}:${f.venue}`));
  assert.deepEqual([...fixtures].sort(), [...supported].sort());
  for (const fixture of forkFixtures) {
    assert.ok(fixture.blockNumber > 0n);
    assert.ok(fixture.reason.length >= 30, `${fixture.chain}/${fixture.venue} needs a meaningful reason`);
  }
});

