import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import { solidlyPairs, v2Pairs } from './routes.js';
import { scanArbOpportunities } from './scanner.js';

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

test('pins all execution-critical reads to one block snapshot', async () => {
  const originalV2 = [...v2Pairs];
  const originalSolidly = [...solidlyPairs];
  const multicallBlocks: bigint[] = [];
  const readContractBlocks: bigint[] = [];
  try {
    v2Pairs.splice(0, v2Pairs.length, {
      chain: 'snapshot-test', tokenA: { symbol: 'A', address: TOKEN_A, decimals: 0 }, tokenB: { symbol: 'B', address: TOKEN_B, decimals: 0 },
      routers: [{ label: 'one', router: ROUTER_ONE }, { label: 'two', router: ROUTER_TWO }], feeBps: 30,
    });
    solidlyPairs.splice(0, solidlyPairs.length, {
      chain: 'snapshot-test', tokenA: { symbol: 'A', address: TOKEN_A, decimals: 0 }, tokenB: { symbol: 'B', address: TOKEN_B, decimals: 0 },
      pool: { chain: 'snapshot-test', label: 'solidly', router: SOLIDLY_ROUTER, factory: SOLIDLY_FACTORY, stable: false, feeBps: 30 },
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
        if (request.functionName === 'stable') return false;
        if (request.functionName === 'fee') return 30n;
        if (request.functionName === 'getAmountsOut') {
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
          return request.contracts.flatMap<any>((contract) => contract.functionName === 'getReserves'
            ? [{ status: 'success', result: contract.address === PAIR_ONE ? [1_000n, 1_000n, 0] : [2_000n, 1_000n, 0] }]
            : [{ status: 'success', result: TOKEN_A }]);
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
    assert.ok(result.opportunities.length > 0, 'mocked reserve imbalance yields an opportunity');
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
