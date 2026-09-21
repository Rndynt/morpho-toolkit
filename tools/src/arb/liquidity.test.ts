import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import { capLoanAmount } from './scanner.js';
import { verifyArbPreflight, type ArbDeployment } from './execution.js';

test('optimal amount below Morpho liquidity is unchanged', () => {
  assert.equal(capLoanAmount(50n, 100n, 1_000n), 50n);
});

test('optimal amount above Morpho liquidity is capped and configured maximum also applies', () => {
  assert.equal(capLoanAmount(150n, 100n, 1_000n), 100n);
  assert.equal(capLoanAmount(150n, 100n, 75n), 75n);
});

test('zero Morpho liquidity rejects the candidate', () => {
  assert.equal(capLoanAmount(50n, 0n, 1_000n), 0n);
});

test('latest preflight rejects liquidity that fell after scan', async () => {
  const address = '0x0000000000000000000000000000000000000001' as const;
  const morpho = '0x0000000000000000000000000000000000000002' as const;
  const owner = '0x0000000000000000000000000000000000000003' as const;
  const code = '0x01' as const;
  const { keccak256 } = await import('viem');
  const deployment: ArbDeployment = { address, version: 'test', bytecodeHash: keccak256(code), owner, morpho, tokens: [], routers: [], aerodromeFactories: [] };
  let read = 0;
  const client = {
    getChainId: async () => 1,
    getBlockNumber: async () => 456n,
    getBytecode: async () => code,
    readContract: async () => [owner, morpho, 99n, 0n][read++],
  } as unknown as PublicClient;
  const plan = {
    opportunity: { loanToken: address }, loanAmountRaw: 100n, profitReceiver: owner, deadline: 9999999999n,
  } as any;
  await assert.rejects(verifyArbPreflight(client, 1, deployment, plan), /insufficient Morpho balance/);
});
