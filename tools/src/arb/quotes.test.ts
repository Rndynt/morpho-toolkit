import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicClient } from 'viem';
import { quoteExactInput } from './quotes.js';

const TOKEN_A = '0x0000000000000000000000000000000000000001' as const;
const TOKEN_B = '0x0000000000000000000000000000000000000002' as const;
const ROUTER = '0x0000000000000000000000000000000000000011' as const;
const FACTORY = '0x0000000000000000000000000000000000000021' as const;
const POOL = '0x0000000000000000000000000000000000000031' as const;

test('Solidly adapter uses the preverified fee and reads pool type at the matching snapshot', async () => {
  const calls: Array<{ functionName: string; args?: readonly unknown[]; blockNumber?: bigint }> = [];
  const client = {
    readContract: async (request: { functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => {
      calls.push(request);
      if (request.functionName === 'stable') return true;
      if (request.functionName === 'getAmountsOut') return [100n, 97n];
      throw new Error(`unexpected ${request.functionName}`);
    },
  } as unknown as PublicClient;

  const quote = await quoteExactInput(client, {
    venue: { kind: 'aerodrome', label: 'test', router: ROUTER, factory: FACTORY, pool: POOL, fee: { bps: 4, blockNumber: 456n, source: { kind: 'factory-getFee', address: FACTORY, raw: 4n, denominator: 10_000n } } },
    tokenIn: TOKEN_A, tokenOut: TOKEN_B, amountInRaw: 100n, snapshotBlock: 456n,
  });

  assert.equal(quote.amountOutRaw, 97n);
  assert.equal(quote.poolType, 'stable');
  assert.equal(quote.feeBps, 4n);
  assert.equal(quote.snapshotBlock, 456n);
  const route = calls.find((call) => call.functionName === 'getAmountsOut')!.args![1] as Array<{ stable: boolean; factory: string }>;
  assert.deepEqual(route, [{ from: TOKEN_A, to: TOKEN_B, stable: true, factory: FACTORY }]);
  assert.deepEqual(calls.map((call) => call.blockNumber), [456n, 456n]);
});
