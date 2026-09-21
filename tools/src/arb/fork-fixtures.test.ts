import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
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

test('Solidity Base fork tests select the pinned fixture block', async () => {
  const baseBlock = forkFixtures.find((fixture) => fixture.chain === 'base')!.blockNumber;
  for (const file of ['MorphoAtomicArbPOCBaseFork.t.sol', 'MorphoAtomicArbPOCv2BaseFork.t.sol']) {
    const source = await readFile(new URL(`../../../evm/test/${file}`, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`BASE_FORK_BLOCK\\s*=\\s*${baseBlock.toLocaleString('en-US').replaceAll(',', '_')}`));
    assert.match(source, /createSelectFork\(vm\.envString\("BASE_RPC_URL"\), BASE_FORK_BLOCK\)/);
  }
});
