import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Hex, type PublicClient } from 'viem';
import {
  assertExecutableToken, liveExecutablePolicyFailure, REQUIRED_FORK_TESTS, tokenPolicyFor,
  type TokenPolicy, type TokenPolicyRegistry,
} from './token-policy.js';

const address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const;
const policy: TokenPolicy = {
  chainId: 1, address, codeHash: `0x${'1'.repeat(64)}`, decimals: 6, symbol: 'USDC',
  proxyImplementation: null, transferBehavior: 'standard', rebasing: false,
  controls: { blacklist: true, pause: true }, status: 'executable', explicitConfiguration: true,
  forkTests: Object.fromEntries(REQUIRED_FORK_TESTS.map((name) => [name, { passed: true, blockNumber: 1 }])) as TokenPolicy['forkTests'],
};

test('token yang tidak terdaftar tetap discovery-only', () => {
  assert.equal(tokenPolicyFor({ ethereum: { chainId: 1, tokens: {} } }, 'ethereum', 1, address), undefined);
  assert.throws(() => assertExecutableToken(undefined), /default discovery-only/);
});

test('identitas policy terikat checksum address dan chain ID', () => {
  const registry: TokenPolicyRegistry = { ethereum: { chainId: 1, tokens: { [address]: policy } } };
  assert.equal(tokenPolicyFor(registry, 'ethereum', 1, address), policy);
  assert.equal(tokenPolicyFor(registry, 'ethereum', 10, address), undefined);
});

test('promosi membutuhkan konfigurasi eksplisit dan seluruh fork-test', () => {
  assert.doesNotThrow(() => assertExecutableToken(policy));
  assert.throws(() => assertExecutableToken({ ...policy, explicitConfiguration: false }), /explicitConfiguration/);
  assert.throws(() => assertExecutableToken({
    ...policy, forkTests: { ...policy.forkTests, rescue: { passed: false } },
  }), /rescue/);
});

const runtime = '0x60006000' as Hex;

function liveClient(overrides: { runtime?: Hex; implementation?: Hex; decimals?: number; symbol?: string } = {}): PublicClient {
  const values = [overrides.decimals ?? 6, overrides.symbol ?? 'USDC'];
  return {
    getBytecode: async () => overrides.runtime ?? runtime,
    getStorageAt: async () => overrides.implementation ?? `0x${'0'.repeat(64)}`,
    readContract: async () => values.shift(),
  } as unknown as PublicClient;
}

test('fingerprint executable dibandingkan dengan state token live dan metadata scanner', async () => {
  const livePolicy = { ...policy, codeHash: keccak256(runtime) };
  assert.equal(await liveExecutablePolicyFailure(liveClient(), address, livePolicy, policy), undefined);
  assert.match(await liveExecutablePolicyFailure(
    liveClient(), '0xdAC17F958D2ee523a2206206994597C13D831ec7' as const, livePolicy, policy,
  ) ?? '', /address token/);
  assert.match(await liveExecutablePolicyFailure(
    liveClient({ runtime: '0x6001' }), address, livePolicy, policy,
  ) ?? '', /codeHash/);
  assert.match(await liveExecutablePolicyFailure(
    liveClient({ decimals: 18 }), address, livePolicy, policy,
  ) ?? '', /decimals/);
  assert.match(await liveExecutablePolicyFailure(
    liveClient(), address, livePolicy, { decimals: 6, symbol: 'USDC.e' },
  ) ?? '', /symbol/);
  assert.match(await liveExecutablePolicyFailure(
    liveClient({ symbol: 'USDC.e' }), address, livePolicy, policy,
  ) ?? '', /symbol/);
});

test('upgrade proxy membatalkan fingerprint policy', async () => {
  const implementation = 'A'.repeat(40);
  const livePolicy = { ...policy, codeHash: keccak256(runtime) };
  assert.match(await liveExecutablePolicyFailure(
    liveClient({ implementation: `0x${'0'.repeat(24)}${implementation}` }), address, livePolicy, policy,
  ) ?? '', /proxyImplementation/);
});

test('proxy implementation live yang sama dengan policy diterima', async () => {
  const implementation = '0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa' as const;
  const livePolicy = { ...policy, codeHash: keccak256(runtime), proxyImplementation: implementation };
  assert.equal(await liveExecutablePolicyFailure(
    liveClient({ implementation: `0x${'0'.repeat(24)}${implementation.slice(2)}` }),
    address,
    livePolicy,
    policy,
  ), undefined);
});
