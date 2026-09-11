import assert from 'node:assert/strict';
import test from 'node:test';
import { encodePocV2Plan } from './plan.js';
import type { ArbOpportunity } from './scanner.js';

const sample: ArbOpportunity = {
  pairLabel: 'USDC/WETH',
  loanTokenSymbol: 'USDC',
  intermediateTokenSymbol: 'WETH',
  loanToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  intermediateToken: '0x4200000000000000000000000000000000000006',
  loanTokenDecimals: 6,
  buyOn: 'Sushi V2',
  sellOn: 'Aerodrome (volatile)',
  buyRouter: '0x6BDED42c6DA8FBf0d2bA55B2fa120C5e0c8D7891',
  sellRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  buyKind: 'v2',
  sellKind: 'aerodrome',
  buyFactory: null,
  sellFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
  loanAmountFormatted: '182.228176',
  grossProfitFormatted: '50.240348',
  estGasCostNative: 0.001,
  estGasCostInLoanToken: 3,
  netProfit: 47.24,
};

test('encodePocV2Plan builds non-empty executeArbitrage calldata', () => {
  const plan = encodePocV2Plan(sample, {
    profitReceiver: '0x000000000000000000000000000000000000dEaD',
  });
  assert.equal(plan.executableByPocV2, true);
  assert.ok(plan.calldata.startsWith('0x'));
  assert.ok(plan.calldata.length > 10);
  assert.equal(plan.loanAmountRaw, 182228176n);
  assert.equal(plan.notes.length, 0);
});

test('encodePocV2Plan flags same-router routes', () => {
  const plan = encodePocV2Plan(
    { ...sample, sellRouter: sample.buyRouter, sellKind: 'v2', sellFactory: null },
    { profitReceiver: '0x000000000000000000000000000000000000dEaD' },
  );
  assert.equal(plan.executableByPocV2, false);
  assert.ok(plan.notes.some((note) => note.includes('same router')));
});
