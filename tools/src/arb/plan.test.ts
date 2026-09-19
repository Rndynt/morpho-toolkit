import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { encodePocV2Plan, MAX_DEADLINE_SECONDS } from './plan.js';
import type { ArbOpportunity } from './scanner.js';

const sample: ArbOpportunity = {
  pairLabel: 'USDC/WETH', loanTokenSymbol: 'USDC', intermediateTokenSymbol: 'WETH',
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', intermediateToken: '0x4200000000000000000000000000000000000006', loanTokenDecimals: 6,
  buyOn: 'Sushi V2', sellOn: 'Aerodrome (volatile)', buyRouter: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891', sellRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  buyKind: 'v2', sellKind: 'aerodrome', buyFactory: null, sellFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  loanAmountFormatted: '182.228176', grossProfitFormatted: '50.240348', estGasCostNative: 0.001, estGasCostInLoanToken: 3, netProfit: 47.24,
};

const safeOptions = {
  profitReceiver: '0x000000000000000000000000000000000000dEaD' as const,
  quotes: { firstLegAmountOutRaw: 100_000_000n, secondLegAmountOutRaw: 240_000_000n, blockNumber: 12_345n },
  costs: { gasCostRaw: 3_000_000n, chainFeeRaw: 500_000n, safetyMarginRaw: 500_000n },
  minProfitRaw: 4_000_000n,
  slippageBps: 100,
};

test('encodePocV2Plan creates calldata only with slippage-protected raw quotes', () => {
  const before = BigInt(Math.floor(Date.now() / 1000));
  const plan = encodePocV2Plan(sample, safeOptions);
  const decoded = decodeFunctionData({ abi: parseAbi([
    'function executeArbitrage((address loanToken, address intermediateToken, (address router, uint8 kind, bool aeroStable, address aeroFactory) firstLeg, (address router, uint8 kind, bool aeroStable, address aeroFactory) secondLeg, uint256 loanAmount, uint256 minIntermediateAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline, address profitReceiver) params)',
  ]), data: plan.calldata });
  const params = decoded.args[0] as { minIntermediateAmount: bigint; minFinalAmount: bigint; minProfit: bigint; deadline: bigint };
  assert.equal(plan.executableByPocV2, true);
  assert.equal(params.minIntermediateAmount, 99_000_000n);
  assert.equal(params.minFinalAmount, 237_600_000n);
  assert.equal(params.minProfit, 4_000_000n);
  assert.ok(params.minIntermediateAmount > 0n);
  assert.ok(params.minFinalAmount >= plan.loanAmountRaw + params.minProfit);
  assert.ok(params.deadline >= before + 60n && params.deadline <= before + 61n);
});

test('encodePocV2Plan rejects missing quote/min-out inputs and unavailable snapshots', () => {
  assert.throws(() => encodePocV2Plan(sample, { profitReceiver: safeOptions.profitReceiver } as never), /quotes/);
  assert.throws(() => encodePocV2Plan(sample, { ...safeOptions, costs: undefined } as never), /costs/);
  assert.throws(() => encodePocV2Plan(sample, { ...safeOptions, quotes: { ...safeOptions.quotes, blockNumber: 0n } }), /blockNumber/);
  assert.throws(() => encodePocV2Plan(sample, { ...safeOptions, quotes: { ...safeOptions.quotes, firstLegAmountOutRaw: 0n } }), /first-leg quote/);
});

test('encodePocV2Plan rejects unsafe final amounts, incomplete costs, and long deadlines', () => {
  assert.throws(() => encodePocV2Plan(sample, { ...safeOptions, quotes: { ...safeOptions.quotes, secondLegAmountOutRaw: 180_000_000n } }), /minFinalAmount/);
  assert.throws(() => encodePocV2Plan(sample, { ...safeOptions, minProfitRaw: 3_999_999n }), /include gas/);
  assert.throws(() => encodePocV2Plan(sample, { ...safeOptions, deadlineSeconds: MAX_DEADLINE_SECONDS + 1 }), /deadlineSeconds/);
});

test('encodePocV2Plan flags same-router routes after safety validation', () => {
  const plan = encodePocV2Plan({ ...sample, sellRouter: sample.buyRouter, sellKind: 'v2', sellFactory: null }, safeOptions);
  assert.equal(plan.executableByPocV2, false);
  assert.ok(plan.notes.some((note) => note.includes('same router')));
});
