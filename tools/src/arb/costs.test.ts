import assert from 'node:assert/strict';
import test from 'node:test';
import { EthereumCostAdapter } from './costs/ethereum.js';
import { costAdapterForChain } from './costs/index.js';
import { applyExecutionCosts, type EncodedArbPlan } from './plan.js';

test('Ethereum adapter estimates exact contract request and itemizes base, priority and relay fees', async () => {
  let received: any;
  const result = await new EthereumCostAdapter().estimate({
    estimateContractGas: async (request) => { received = request; return 100n; },
    getBlock: async () => ({ baseFeePerGas: 10n }),
    estimateMaxPriorityFeePerGas: async () => 2n,
    readContract: async () => 0n,
  }, { account: '0x01', address: '0x02', data: '0x1234', abi: [], functionName: 'executeArbitrage', args: [7n] }, 50n);
  assert.equal(received.functionName, 'executeArbitrage');
  assert.deepEqual(received.args, [7n]);
  assert.equal(received.data, undefined, 'estimateContractGas receives decoded contract parameters, not a second payload');
  assert.equal(result.baseFeePerGas, 20n);
  assert.equal(result.priorityFeePerGas, 2n);
  assert.equal(result.gasFeeNative, 2_200n);
  assert.equal(result.relayBidNative, 50n);
  assert.equal(result.totalNative, 2_250n);
});

test('chain adapters fail closed when an official oracle is not configured', () => {
  assert.throws(() => costAdapterForChain(999), /no official execution-cost oracle/);
});

test('net profit subtracts every execution cost and enforces absolute and bps floors', () => {
  const plan = { loanAmountRaw: 10_000n, grossProfitRaw: 1_000n } as EncodedArbPlan;
  const costs = { gasCostRaw: 100n, l1FeeRaw: 200n, relayBidRaw: 50n, safetyMarginRaw: 25n };
  assert.equal(applyExecutionCosts(plan, costs, { minNetProfitRaw: 600n, minNetProfitBps: 600 }).netProfitRaw, 625n);
  assert.throws(() => applyExecutionCosts(plan, costs, { minNetProfitRaw: 626n }), /absolute floor/);
  assert.throws(() => applyExecutionCosts(plan, costs, { minNetProfitBps: 626 }), /capital floor/);
});
