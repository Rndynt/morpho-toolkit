import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import { solidlyPairs, v2Pairs } from './routes.js';
import { normalizeFeeBps, optimizeQuoteDriven, readAerodromeFee, scanArbOpportunities } from './scanner.js';

const SNAPSHOT_BLOCK = 12_345n;
const TOKEN_A = '0x0000000000000000000000000000000000000001' as const;
const TOKEN_B = '0x0000000000000000000000000000000000000002' as const;
const ROUTER_ONE = '0x0000000000000000000000000000000000000011' as const;
const ROUTER_TWO = '0x0000000000000000000000000000000000000012' as const;
const FACTORY_ONE = '0x0000000000000000000000000000000000000021' as const;
const FACTORY_TWO = '0x0000000000000000000000000000000000000022' as const;
const PAIR_ONE = '0x0000000000000000000000000000000000000031' as const;
const PAIR_TWO = '0x0000000000000000000000000000000000000032' as const;
const SOLIDLY_FACTORY = '0x0000000000000000000000000000000000000041' as const;
const SOLIDLY_POOL = '0x0000000000000000000000000000000000000042' as const;
const SOLIDLY_ROUTER = '0x0000000000000000000000000000000000000043' as const;

test('normalizes 4, 25, 30, and 100 bps from explicit fee-unit denominators', () => {
  assert.equal(normalizeFeeBps(4n, 10_000n), 4);
  assert.equal(normalizeFeeBps(2_500n, 1_000_000n), 25);
  assert.equal(normalizeFeeBps(30n, 10_000n), 30);
  assert.equal(normalizeFeeBps(10_000n, 1_000_000n), 100);
  assert.throws(() => normalizeFeeBps(1n, 3n), /not an exact basis-point value/);
});

test('reads a changed Aerodrome factory fee at each requested snapshot', async () => {
  const blocks: bigint[] = [];
  const client = {
    readContract: async ({ blockNumber, functionName }: { blockNumber: bigint; functionName: string }) => {
      assert.equal(functionName, 'getFee');
      blocks.push(blockNumber);
      return blockNumber === 100n ? 4n : 30n;
    },
  } as unknown as PublicClient;
  const oldFee = await readAerodromeFee(client, SOLIDLY_FACTORY, SOLIDLY_POOL, false, 100n);
  const newFee = await readAerodromeFee(client, SOLIDLY_FACTORY, SOLIDLY_POOL, false, 200n);
  assert.equal(oldFee.bps, 4);
  assert.equal(newFee.bps, 30);
  assert.deepEqual(blocks, [100n, 200n]);
  assert.equal(oldFee.source.kind, 'factory-getFee');
});

test('quote-driven optimizer follows a stable curve instead of a constant-product estimate', async () => {
  const quotedAmounts: bigint[] = [];
  const optimum = 700n;
  const result = await optimizeQuoteDriven(1_000n, async (amountInRaw) => {
    quotedAmounts.push(amountInRaw);
    // Mock a locally flat stable invariant with an optimum deliberately unrelated to
    // the reserve-ratio optimum a constant-product formula would produce.
    const distance = amountInRaw - optimum;
    const profit = 500_000n - distance * distance;
    return {
      intermediateRaw: amountInRaw * 2n,
      finalRaw: amountInRaw + profit,
      firstPoolType: 'stable' as const,
      secondPoolType: 'v2' as const,
    };
  }, 48);

  assert.ok(result);
  assert.ok(result.grossProfitRaw > 499_990n);
  assert.ok(result.loanAmountRaw >= 697n && result.loanAmountRaw <= 703n, `found ${result.loanAmountRaw}`);
  assert.ok(quotedAmounts.length <= 48, 'maximum quote evaluations is enforced');
  assert.ok(quotedAmounts.every((amount) => typeof amount === 'bigint'));
});

test('pins all execution-critical reads to one block snapshot', async () => {
  const originalV2 = [...v2Pairs];
  const originalSolidly = [...solidlyPairs];
  const multicallBlocks: bigint[] = [];
  const readContractBlocks: bigint[] = [];
  let routerQuoteCalls = 0;
  try {
    v2Pairs.splice(0, v2Pairs.length, {
      chain: 'snapshot-test', tokenA: { symbol: 'A', address: TOKEN_A, decimals: 0 }, tokenB: { symbol: 'B', address: TOKEN_B, decimals: 0 },
      routers: [
        { label: 'one', router: ROUTER_ONE, feeModel: { kind: 'fixed-bps', feeBps: 25, protocol: 'uniswap-v2' } },
        { label: 'two', router: ROUTER_TWO, feeModel: { kind: 'fixed-bps', feeBps: 100, protocol: 'sushiswap-v2' } },
        { label: 'unknown', router: '0x0000000000000000000000000000000000000013', feeModel: { kind: 'unsupported', reason: 'unknown invariant' } },
      ],
    });
    solidlyPairs.splice(0, solidlyPairs.length, {
      chain: 'snapshot-test', tokenA: { symbol: 'A', address: TOKEN_A, decimals: 0 }, tokenB: { symbol: 'B', address: TOKEN_B, decimals: 0 },
      pool: { chain: 'snapshot-test', label: 'solidly stable', router: SOLIDLY_ROUTER, factory: SOLIDLY_FACTORY, stable: true },
    });

    const client = {
      getChainId: async () => 999,
      getBlockNumber: async () => SNAPSHOT_BLOCK,
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
        assert.equal(blockNumber, SNAPSHOT_BLOCK);
        return { hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timestamp: 1_700_000_000n };
      },
      getGasPrice: async () => 1n,
      readContract: async (request: { blockNumber?: bigint; functionName: string; args?: readonly unknown[] }) => {
        readContractBlocks.push(request.blockNumber!);
        if (request.functionName === 'getPool') return SOLIDLY_POOL;
        if (request.functionName === 'stable') return true;
        if (request.functionName === 'getAmountsOut') {
          routerQuoteCalls++;
          const amountIn = request.args![0] as bigint;
          return [amountIn, amountIn * 2n];
        }
        throw new Error(`unexpected readContract: ${request.functionName}`);
      },
      multicall: async (request: { blockNumber?: bigint; contracts: Array<{ functionName: string; address: string }> }): Promise<any> => {
        multicallBlocks.push(request.blockNumber!);
        const functionName = request.contracts[0]!.functionName;
        if (functionName === 'factory') return [{ status: 'success', result: FACTORY_ONE }, { status: 'success', result: FACTORY_TWO }];
        if (functionName === 'getPair') return [{ status: 'success', result: PAIR_ONE }, { status: 'success', result: PAIR_TWO }];
        if (functionName === 'getReserves') {
          return request.contracts.map<any>((contract) => contract.functionName === 'getReserves'
            ? { status: 'success', result: contract.address === PAIR_ONE ? [1_000n, 1_000n, 0] : contract.address === PAIR_TWO ? [2_000n, 1_000n, 0] : [1_000n, 1_000n] }
            : contract.functionName === 'getFee' ? { status: 'success', result: 4n }
            : { status: 'success', result: TOKEN_A });
        }
        throw new Error(`unexpected multicall: ${functionName}`);
      },
    } as unknown as PublicClient;

    const result = await scanArbOpportunities({
      chain: { key: 'snapshot-test', name: 'Snapshot test', chainId: 999, rpcEnv: 'UNUSED', nativeSymbol: 'ETH', explorer: 'https://example.test', status: 'active' },
      rpcUrl: 'http://unused.test', publicClient: client,
    });

    assert.ok(multicallBlocks.length >= 4, 'factory, pair, V2 reserve, and Solidly reserve reads run');
    assert.deepEqual(multicallBlocks, multicallBlocks.map(() => SNAPSHOT_BLOCK));
    assert.ok(readContractBlocks.length > 1, 'pool metadata and router quotes run');
    assert.deepEqual(readContractBlocks, readContractBlocks.map(() => SNAPSHOT_BLOCK));
    assert.equal(result.blockNumber, SNAPSHOT_BLOCK);
    assert.equal(result.blockHash, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(result.blockTimestamp, 1_700_000_000n);
    assert.ok(result.venueTvl.length > 0);
    assert.ok(result.venueTvl.every((venue) => venue.status === 'unpriced'));
    assert.ok(result.venueTvl.every((venue) => venue.executableCandidate === false));
    assert.ok(result.opportunities.length > 0, 'mocked reserve imbalance yields an opportunity');
    assert.ok(result.skipped.some((venue) => venue.router === 'unknown' && venue.reason.includes('non-executable')));
    assert.ok(routerQuoteCalls > 2, 'stable leg is sized from multiple router quotes, not one closed-form result');
    for (const opportunity of result.opportunities) {
      assert.equal(opportunity.blockNumber, SNAPSHOT_BLOCK);
      assert.equal(opportunity.blockHash, result.blockHash);
      assert.equal(opportunity.blockTimestamp, result.blockTimestamp);
    }
  } finally {
    v2Pairs.splice(0, v2Pairs.length, ...originalV2);
    solidlyPairs.splice(0, solidlyPairs.length, ...originalSolidly);
  }
});
