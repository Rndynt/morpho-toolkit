import type { Hex } from 'viem';
import type { Address } from '../../config/registry.js';
import type { EncodedArbPlan, RawLegQuotes } from '../plan.js';

export type BlockSnapshot = {
  blockNumber: bigint;
  blockHash: Hex;
  /** Hash of the ordered pool addresses and all state used to produce the quote. */
  poolStateFingerprint: Hex;
};

export type SubmissionPlan = {
  execution: EncodedArbPlan;
  snapshot: BlockSnapshot;
  expectedQuotes: RawLegQuotes;
  constraints: {
    maxSnapshotAgeBlocks: bigint;
    minNetProfitRaw: bigint;
    maxNetProfitRaw?: bigint;
  };
};

export type SubmissionMode = 'simulation-only' | 'private-relay';

export type ReplacementPolicy = {
  /** Total target blocks, including the first attempt. */
  maxBlocks: number;
  /** Replace a still-pending payload every N target blocks. */
  replaceAfterBlocks: number;
  feeBumpBps: number;
  /** Ask the relay to cancel outstanding payloads after the attempt window. */
  cancelAfterMaxBlocks: boolean;
};

export type SubmissionConfig = {
  mode?: SubmissionMode;
  /** Deliberately false by default; this module never performs an implicit fallback. */
  publicRpcSubmission?: boolean;
  confirmations?: number;
  replacement?: Partial<ReplacementPolicy>;
};

export type Head = { number: bigint; hash: Hex };
export type SignedPayload = { rawTransaction: Hex; transactionHash: Hex };
export type RelaySendResult = { relayId: string; transactionHash?: Hex };
export type Receipt = { transactionHash: Hex; blockNumber: bigint; blockHash: Hex; status: 'success' | 'reverted' };

export interface SubmissionChain {
  readHead(): Promise<Head>;
  readBlockHash(blockNumber: bigint): Promise<Hex | null>;
  quoteBoth(plan: SubmissionPlan, blockNumber: bigint): Promise<RawLegQuotes>;
  fingerprintPools(plan: SubmissionPlan, blockNumber: bigint): Promise<Hex>;
  simulate(plan: SubmissionPlan, blockNumber: bigint): Promise<void>;
  getReceipt(hash: Hex): Promise<Receipt | null>;
}

export interface PrivateRelay {
  /** Whether this relay/chain pair supports private transaction or bundle submission. */
  supported: boolean;
  send(payload: SignedPayload, targetBlock: bigint): Promise<RelaySendResult>;
  replace?(relayId: string, payload: SignedPayload, targetBlock: bigint, feeBumpBps: number): Promise<RelaySendResult>;
  cancel?(relayId: string): Promise<void>;
}

export type SignRequest = {
  to: Address;
  data: Hex;
  targetBlock: bigint;
  replacementAttempt: number;
  feeBumpBps: number;
};

export type CandidateLogger = (event: {
  outcome: 'not-sent' | 'simulated' | 'submitted' | 'confirmed' | 'reorged' | 'cancelled';
  reason: string;
  transactionHash?: Hex;
  targetBlock?: bigint;
}) => void;

