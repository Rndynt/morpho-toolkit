import type { Hex } from 'viem';
import type { EncodedArbPlan, RawLegQuotes } from '../plan.js';
import type { SubmissionPlan } from './types.js';

/** Creates the immutable safety envelope used again immediately before signing. */
export function createSubmissionPlan(input: {
  execution: EncodedArbPlan;
  blockHash: Hex;
  poolStateFingerprint: Hex;
  expectedQuotes: RawLegQuotes;
  maxSnapshotAgeBlocks: bigint;
  minNetProfitRaw?: bigint;
  maxNetProfitRaw?: bigint;
}): SubmissionPlan {
  if (input.expectedQuotes.blockNumber !== input.execution.opportunity.blockNumber) {
    throw new Error('submission quote block does not match opportunity snapshot');
  }
  if (input.blockHash.toLowerCase() !== input.execution.opportunity.blockHash.toLowerCase()) {
    throw new Error('submission block hash does not match opportunity snapshot');
  }
  if (input.maxSnapshotAgeBlocks < 0n) throw new Error('maxSnapshotAgeBlocks must be non-negative');
  const min = input.minNetProfitRaw ?? input.execution.netProfitRaw;
  if (input.maxNetProfitRaw !== undefined && input.maxNetProfitRaw < min) {
    throw new Error('maxNetProfitRaw must not be below minNetProfitRaw');
  }
  return {
    execution: input.execution,
    snapshot: {
      blockNumber: input.expectedQuotes.blockNumber,
      blockHash: input.blockHash,
      poolStateFingerprint: input.poolStateFingerprint,
    },
    expectedQuotes: input.expectedQuotes,
    constraints: { maxSnapshotAgeBlocks: input.maxSnapshotAgeBlocks, minNetProfitRaw: min, maxNetProfitRaw: input.maxNetProfitRaw },
  };
}

