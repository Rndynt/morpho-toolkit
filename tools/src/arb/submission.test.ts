import assert from 'node:assert/strict';
import test from 'node:test';
import type { EncodedArbPlan } from './plan.js';
import { createSubmissionPlan, submitArbitrage, type SubmissionChain } from './submission/index.js';

const hash = (digit: string) => `0x${digit.repeat(64)}` as `0x${string}`;
const address = `0x${'1'.repeat(40)}` as const;
const quotes = { firstLegAmountOutRaw: 120n, secondLegAmountOutRaw: 110n, blockNumber: 10n };
const execution = {
  opportunity: { blockNumber: 10n, blockHash: hash('a') }, loanAmountRaw: 100n,
  costs: { gasCostRaw: 1n, l1FeeRaw: 1n, relayBidRaw: 1n, safetyMarginRaw: 1n },
  netProfitRaw: 6n, calldata: '0x1234',
} as unknown as EncodedArbPlan;
const plan = createSubmissionPlan({ execution, blockHash: hash('a'), poolStateFingerprint: hash('b'), expectedQuotes: quotes, maxSnapshotAgeBlocks: 2n });

function chain(overrides: Partial<SubmissionChain> = {}): SubmissionChain {
  return {
    readHead: async () => ({ number: 11n, hash: hash('c') }),
    readBlockHash: async (number) => number === 10n ? hash('a') : hash('d'),
    quoteBoth: async () => ({ ...quotes, blockNumber: 11n }),
    fingerprintPools: async () => hash('b'),
    simulate: async () => undefined,
    getReceipt: async () => null,
    ...overrides,
  };
}

test('submission defaults to simulation-only and never invokes the signer', async () => {
  let signed = false;
  const result = await submitArbitrage({ plan, executor: address, chain: chain(), signer: async () => { signed = true; throw new Error('must not sign'); } });
  assert.equal(result.status, 'simulated');
  assert.equal(signed, false);
});

test('pre-sign checks reject reorgs and quote deterioration with a logged reason', async () => {
  const reasons: string[] = [];
  const reorg = await submitArbitrage({ plan, executor: address, chain: chain({ readBlockHash: async () => hash('e') }), signer: async () => { throw new Error('must not sign'); }, logger: (event) => reasons.push(event.reason) });
  assert.equal(reorg.status, 'not-sent');
  assert.match(reasons[0], /reorg/);

  const lower = await submitArbitrage({ plan, executor: address, chain: chain({ quoteBoth: async () => ({ ...quotes, firstLegAmountOutRaw: 119n }) }), signer: async () => { throw new Error('must not sign'); } });
  assert.deepEqual(lower, { status: 'not-sent', reason: 'first-leg output decreased' });
});

test('private relay targets a block and confirms only a canonical receipt', async () => {
  const tx = hash('f');
  let target = 0n;
  const result = await submitArbitrage({
    plan, executor: address,
    chain: chain({
      readHead: async () => ({ number: 11n, hash: hash('c') }),
      getReceipt: async () => ({ transactionHash: tx, blockNumber: 11n, blockHash: hash('d'), status: 'success' }),
    }),
    relay: { supported: true, send: async (_payload, targetBlock) => { target = targetBlock; return { relayId: 'private-1', transactionHash: tx }; } },
    config: { mode: 'private-relay' },
    signer: async () => ({ rawTransaction: '0x01', transactionHash: tx }),
  });
  assert.equal(target, 12n);
  assert.equal(result.status, 'confirmed');
});

test('public RPC opt-in is rejected rather than falling back to the mempool', async () => {
  const result = await submitArbitrage({ plan, executor: address, chain: chain(), config: { publicRpcSubmission: true }, signer: async () => { throw new Error('must not sign'); } });
  assert.equal(result.status, 'not-sent');
  assert.match(result.reason, /public RPC/);
});
