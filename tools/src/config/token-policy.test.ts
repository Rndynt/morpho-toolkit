import assert from 'node:assert/strict';
import test from 'node:test';
import { assertExecutableToken, REQUIRED_FORK_TESTS, tokenPolicyFor, type TokenPolicy, type TokenPolicyRegistry } from './token-policy.js';

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
