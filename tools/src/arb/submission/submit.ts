import type { Address } from '../../config/registry.js';
import type { CandidateLogger, PrivateRelay, ReplacementPolicy, SignedPayload, SubmissionChain, SubmissionConfig, SubmissionPlan } from './types.js';

const DEFAULT_REPLACEMENT: ReplacementPolicy = {
  maxBlocks: 1, replaceAfterBlocks: 1, feeBumpBps: 1_000, cancelAfterMaxBlocks: true,
};

export type SubmissionResult =
  | { status: 'not-sent' | 'simulated'; reason: string }
  | { status: 'confirmed'; transactionHash: `0x${string}`; blockNumber: bigint };

function reject(log: CandidateLogger, reason: string): SubmissionResult {
  log({ outcome: 'not-sent', reason });
  return { status: 'not-sent', reason };
}

/**
 * Fail-closed submission coordinator. The final head, canonical hash, pool state and
 * both dependent quotes are read before the signer is ever invoked.
 */
export async function submitArbitrage(input: {
  plan: SubmissionPlan;
  executor: Address;
  chain: SubmissionChain;
  relay?: PrivateRelay;
  config?: SubmissionConfig;
  signer: (request: { to: Address; data: `0x${string}`; targetBlock: bigint; replacementAttempt: number; feeBumpBps: number }) => Promise<SignedPayload>;
  logger?: CandidateLogger;
}): Promise<SubmissionResult> {
  const log = input.logger ?? (() => undefined);
  const config = input.config ?? {};
  const mode = config.mode ?? 'simulation-only';
  if (config.publicRpcSubmission === true) return reject(log, 'public RPC submission is disabled; no public-mempool fallback is permitted');

  const head = await input.chain.readHead();
  const { plan } = input;
  if (head.number < plan.snapshot.blockNumber || head.number - plan.snapshot.blockNumber > plan.constraints.maxSnapshotAgeBlocks) {
    return reject(log, 'snapshot is too old or ahead of the current head');
  }
  const canonicalHash = await input.chain.readBlockHash(plan.snapshot.blockNumber);
  if (!canonicalHash || canonicalHash.toLowerCase() !== plan.snapshot.blockHash.toLowerCase()) return reject(log, 'snapshot block hash changed (reorg)');

  const [fingerprint, quotes] = await Promise.all([
    input.chain.fingerprintPools(plan, head.number), input.chain.quoteBoth(plan, head.number),
  ]);
  if (fingerprint.toLowerCase() !== plan.snapshot.poolStateFingerprint.toLowerCase()) return reject(log, 'pool state fingerprint changed');
  if (quotes.firstLegAmountOutRaw < plan.expectedQuotes.firstLegAmountOutRaw) return reject(log, 'first-leg output decreased');
  if (quotes.secondLegAmountOutRaw < plan.expectedQuotes.secondLegAmountOutRaw) return reject(log, 'second-leg output decreased');
  const costs = plan.execution.costs;
  const netProfit = quotes.secondLegAmountOutRaw - plan.execution.loanAmountRaw - costs.gasCostRaw - costs.l1FeeRaw - costs.relayBidRaw - costs.safetyMarginRaw;
  if (netProfit < plan.constraints.minNetProfitRaw) return reject(log, `net profit ${netProfit} is below limit ${plan.constraints.minNetProfitRaw}`);
  if (plan.constraints.maxNetProfitRaw !== undefined && netProfit > plan.constraints.maxNetProfitRaw) return reject(log, `net profit ${netProfit} is above limit ${plan.constraints.maxNetProfitRaw}`);

  await input.chain.simulate(plan, head.number);
  if (mode === 'simulation-only') {
    log({ outcome: 'simulated', reason: 'simulation succeeded; signing and submission disabled' });
    return { status: 'simulated', reason: 'simulation succeeded; signing and submission disabled' };
  }
  if (!input.relay?.supported) return reject(log, 'private relay is not supported for this chain');

  // Simulation may be slow. Repeat every market/canonicality read at the actual
  // signing boundary so the signer never sees a plan validated against old data.
  const signingHead = await input.chain.readHead();
  if (signingHead.number < plan.snapshot.blockNumber || signingHead.number - plan.snapshot.blockNumber > plan.constraints.maxSnapshotAgeBlocks) {
    return reject(log, 'snapshot became too old before signing');
  }
  const signingCanonicalHash = await input.chain.readBlockHash(plan.snapshot.blockNumber);
  if (!signingCanonicalHash || signingCanonicalHash.toLowerCase() !== plan.snapshot.blockHash.toLowerCase()) return reject(log, 'snapshot block hash changed before signing (reorg)');
  const [signingFingerprint, signingQuotes] = await Promise.all([
    input.chain.fingerprintPools(plan, signingHead.number), input.chain.quoteBoth(plan, signingHead.number),
  ]);
  if (signingFingerprint.toLowerCase() !== plan.snapshot.poolStateFingerprint.toLowerCase()) return reject(log, 'pool state fingerprint changed before signing');
  if (signingQuotes.firstLegAmountOutRaw < plan.expectedQuotes.firstLegAmountOutRaw) return reject(log, 'first-leg output decreased before signing');
  if (signingQuotes.secondLegAmountOutRaw < plan.expectedQuotes.secondLegAmountOutRaw) return reject(log, 'second-leg output decreased before signing');
  const signingNetProfit = signingQuotes.secondLegAmountOutRaw - plan.execution.loanAmountRaw - costs.gasCostRaw - costs.l1FeeRaw - costs.relayBidRaw - costs.safetyMarginRaw;
  if (signingNetProfit < plan.constraints.minNetProfitRaw || (plan.constraints.maxNetProfitRaw !== undefined && signingNetProfit > plan.constraints.maxNetProfitRaw)) {
    return reject(log, `net profit ${signingNetProfit} crossed a configured limit before signing`);
  }

  const policy = { ...DEFAULT_REPLACEMENT, ...config.replacement };
  if (!Number.isInteger(policy.maxBlocks) || policy.maxBlocks < 1 || !Number.isInteger(policy.replaceAfterBlocks) || policy.replaceAfterBlocks < 1) {
    return reject(log, 'invalid replacement policy');
  }
  let relayId: string | undefined;
  let transactionHash: `0x${string}` | undefined;
  for (let attempt = 0; attempt < policy.maxBlocks; attempt += policy.replaceAfterBlocks) {
    const targetBlock = signingHead.number + 1n + BigInt(attempt);
    const payload = await input.signer({ to: input.executor, data: plan.execution.calldata, targetBlock, replacementAttempt: attempt, feeBumpBps: attempt === 0 ? 0 : policy.feeBumpBps });
    const sent = relayId && input.relay.replace
      ? await input.relay.replace(relayId, payload, targetBlock, policy.feeBumpBps)
      : await input.relay.send(payload, targetBlock);
    relayId = sent.relayId;
    transactionHash = sent.transactionHash ?? payload.transactionHash;
    log({ outcome: 'submitted', reason: attempt === 0 ? 'private submission accepted' : 'private replacement accepted', transactionHash, targetBlock });
    const receipt = await input.chain.getReceipt(transactionHash);
    if (!receipt) continue;
    if (receipt.status !== 'success') return reject(log, 'submitted transaction reverted');
    const canonicalReceiptHash = await input.chain.readBlockHash(receipt.blockNumber);
    if (canonicalReceiptHash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      log({ outcome: 'reorged', reason: 'receipt block was reorged', transactionHash });
      continue;
    }
    const confirmationHead = await input.chain.readHead();
    const confirmations = config.confirmations ?? 1;
    if (confirmationHead.number - receipt.blockNumber + 1n < BigInt(confirmations)) continue;
    log({ outcome: 'confirmed', reason: `${confirmations} confirmation(s) on canonical chain`, transactionHash });
    return { status: 'confirmed', transactionHash, blockNumber: receipt.blockNumber };
  }
  if (relayId && policy.cancelAfterMaxBlocks && input.relay.cancel) {
    await input.relay.cancel(relayId);
    log({ outcome: 'cancelled', reason: 'private attempt window exhausted', transactionHash });
  }
  return reject(log, 'private attempt window exhausted without a canonical confirmed receipt');
}
