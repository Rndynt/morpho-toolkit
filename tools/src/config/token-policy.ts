import { readFile } from 'node:fs/promises';
import { getAddress, keccak256, parseAbi, type PublicClient } from 'viem';
import { tokenPoliciesPath, type Address } from './registry.js';

export const REQUIRED_FORK_TESTS = [
  'transfer', 'approve', 'flashloanReceipt', 'swapOut', 'swapBack', 'repayment', 'rescue',
] as const;

export type ForkTestName = typeof REQUIRED_FORK_TESTS[number];
export type TokenPolicyStatus = 'discovery-only' | 'executable';
export type ForkTestResult = { passed: boolean; blockNumber?: number; transaction?: `0x${string}`; notes?: string };
export type TokenPolicy = {
  chainId: number;
  address: Address;
  codeHash: `0x${string}`;
  decimals: number;
  symbol: string;
  proxyImplementation: Address | null;
  transferBehavior: 'standard' | 'fee-on-transfer' | 'callback' | 'non-standard';
  rebasing: boolean;
  controls: { blacklist: boolean; pause: boolean };
  status: TokenPolicyStatus;
  explicitConfiguration: boolean;
  forkTests: Record<ForkTestName, ForkTestResult>;
};
export type TokenPolicyRegistry = Record<string, { chainId: number; tokens: Record<string, TokenPolicy> }>;

const erc20MetadataAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

// bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
export const EIP1967_IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;

export async function loadTokenPolicies(): Promise<TokenPolicyRegistry> {
  return JSON.parse(await readFile(tokenPoliciesPath, 'utf8')) as TokenPolicyRegistry;
}

/** API-discovered and absent tokens deliberately resolve to discovery-only. */
export function tokenPolicyFor(
  registry: TokenPolicyRegistry,
  chainKey: string,
  chainId: number,
  address: Address,
): TokenPolicy | undefined {
  const chain = registry[chainKey];
  if (!chain || chain.chainId !== chainId) return undefined;
  const checksum = getAddress(address);
  const policy = chain.tokens[checksum];
  if (!policy || policy.chainId !== chainId || policy.address !== checksum) return undefined;
  return policy;
}

export function executablePolicyFailure(policy: TokenPolicy | undefined): string | undefined {
  if (!policy) return 'tidak memiliki konfigurasi policy eksplisit (default discovery-only)';
  if (!policy.explicitConfiguration) return 'explicitConfiguration bukan true';
  if (policy.status !== 'executable') return `status policy adalah ${policy.status}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(policy.codeHash)) return 'codeHash runtime tidak valid';
  if (!Number.isInteger(policy.decimals) || policy.decimals < 0 || policy.decimals > 255) return 'decimals tidak valid';
  if (!policy.symbol) return 'symbol kosong';
  if (policy.proxyImplementation !== null && getAddress(policy.proxyImplementation) !== policy.proxyImplementation) {
    return 'proxyImplementation bukan checksum address';
  }
  if (typeof policy.rebasing !== 'boolean'
    || typeof policy.controls?.blacklist !== 'boolean'
    || typeof policy.controls?.pause !== 'boolean') return 'risk controls belum dikonfigurasi eksplisit';
  const missing = REQUIRED_FORK_TESTS.filter((name) => !policy.forkTests?.[name]?.passed);
  if (missing.length) return `fork-test belum lulus: ${missing.join(', ')}`;
  return undefined;
}

export function assertExecutableToken(policy: TokenPolicy | undefined): void {
  const failure = executablePolicyFailure(policy);
  if (failure) throw new Error(`token tidak executable: ${failure}`);
}

export type ExpectedTokenMetadata = { decimals: number; symbol: string };

/** Validate a policy fingerprint against the token currently deployed on the selected chain. */
export async function liveExecutablePolicyFailure(
  client: PublicClient,
  address: Address,
  policy: TokenPolicy | undefined,
  expected: ExpectedTokenMetadata,
): Promise<string | undefined> {
  const configuredFailure = executablePolicyFailure(policy);
  if (configuredFailure || !policy) return configuredFailure;

  // Keep this assertion local to the live validator too.  Callers should
  // normally obtain the policy through tokenPolicyFor(), but validating the
  // binding here prevents a valid fingerprint for one token from being
  // accidentally checked against (and used to authorize) another address.
  if (getAddress(address) !== policy.address) {
    return `address token ${getAddress(address)} tidak cocok dengan policy ${policy.address}`;
  }

  const [bytecode, implementationWord, decimals, symbol] = await Promise.all([
    client.getBytecode({ address }),
    client.getStorageAt({ address, slot: EIP1967_IMPLEMENTATION_SLOT }),
    client.readContract({ address, abi: erc20MetadataAbi, functionName: 'decimals' }),
    client.readContract({ address, abi: erc20MetadataAbi, functionName: 'symbol' }),
  ]);
  if (!bytecode || bytecode === '0x') return 'runtime bytecode token tidak ditemukan';
  if (keccak256(bytecode).toLowerCase() !== policy.codeHash.toLowerCase()) {
    return 'runtime codeHash tidak cocok dengan policy';
  }

  const implementationHex = implementationWord?.slice(-40);
  const liveImplementation = implementationHex && !/^0{40}$/.test(implementationHex)
    ? getAddress(`0x${implementationHex}`) as Address
    : null;
  if (liveImplementation !== policy.proxyImplementation) {
    return `proxyImplementation on-chain ${liveImplementation ?? 'null'} tidak cocok dengan policy`;
  }
  if (Number(decimals) !== policy.decimals || expected.decimals !== policy.decimals) {
    return `decimals on-chain/scanner tidak cocok dengan policy (${Number(decimals)}/${expected.decimals}/${policy.decimals})`;
  }
  if (symbol !== policy.symbol || expected.symbol !== policy.symbol) {
    return `symbol on-chain/scanner tidak cocok dengan policy (${symbol}/${expected.symbol}/${policy.symbol})`;
  }
  return undefined;
}
