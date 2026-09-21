import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import type { Address } from '../config/registry.js';
import type { ArbOpportunity } from './scanner.js';
import type { VenueKind } from './routes.js';

const pocV2Abi = parseAbi([
  'function executeArbitrage((address loanToken, address intermediateToken, (address router, address pool, uint8 kind, bool aeroStable, address aeroFactory) firstLeg, (address router, address pool, uint8 kind, bool aeroStable, address aeroFactory) secondLeg, uint256 loanAmount, uint256 minIntermediateAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
]);

/** The execution window is deliberately short so a quote cannot become stale. */
export const MIN_DEADLINE_SECONDS = 1;
export const MAX_DEADLINE_SECONDS = 300;
const BPS_DENOMINATOR = 10_000n;

export type RawLegQuotes = {
  /** Exact-input amount quoted for the first swap at blockNumber. */
  firstLegAmountOutRaw: bigint;
  /** Exact-input amount quoted for the second swap at blockNumber. */
  secondLegAmountOutRaw: bigint;
  /** Block at which both quotes were obtained. */
  blockNumber: bigint;
};

export type ExecutionCostsRaw = {
  /** Gas cost denominated in the loan token. */
  gasCostRaw: bigint;
  /** Rollup L1 data fee denominated in the loan token. */
  l1FeeRaw: bigint;
  /** Private relay/builder payment denominated in the loan token. */
  relayBidRaw: bigint;
  /** Additional loan-token buffer for estimation and execution risk. */
  safetyMarginRaw: bigint;
};

export type EncodedArbPlan = {
  opportunity: ArbOpportunity;
  loanAmountRaw: bigint;
  minIntermediateAmount: bigint;
  minFinalAmount: bigint;
  minProfitRaw: bigint;
  deadline: bigint;
  profitReceiver: Address;
  calldata: Hex;
  costs: ExecutionCostsRaw;
  grossProfitRaw: bigint;
  netProfitRaw: bigint;
  executableByPocV2: boolean;
  notes: string[];
};

export function applyExecutionCosts(
  plan: EncodedArbPlan,
  costs: ExecutionCostsRaw,
  thresholds: { minNetProfitRaw?: bigint; minNetProfitBps?: number } = {},
): EncodedArbPlan {
  for (const [field, value] of Object.entries(costs)) requireNonNegative(value, field);
  const total = costs.gasCostRaw + costs.l1FeeRaw + costs.relayBidRaw + costs.safetyMarginRaw;
  const netProfitRaw = plan.grossProfitRaw - total;
  const absolute = thresholds.minNetProfitRaw ?? 0n;
  const bps = thresholds.minNetProfitBps ?? 0;
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error('minNetProfitBps must be from 0 through 10000');
  const relative = (plan.loanAmountRaw * BigInt(bps) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  if (netProfitRaw < absolute) throw new Error(`net profit ${netProfitRaw} is below absolute floor ${absolute}`);
  if (netProfitRaw < relative) throw new Error(`net profit ${netProfitRaw} is below ${bps} bps capital floor ${relative}`);
  return { ...plan, costs, netProfitRaw };
}

function kindToEnum(kind: VenueKind): number {
  return kind === 'aerodrome' ? 1 : 0;
}

function minAmountAfterSlippage(quoteAmountRaw: bigint, slippageBps: number): bigint {
  return (quoteAmountRaw * BigInt(10_000 - slippageBps)) / BPS_DENOMINATOR;
}

function requirePositive(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new Error(`${field} must be greater than zero`);
}

function requireNonNegative(value: bigint, field: string): void {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`${field} must be a non-negative bigint`);
}

/**
 * Produces calldata only from block-pinned raw quotes and fully accounted loan-token
 * costs. This function fails closed: callers must refresh a quote, snapshot, or costs
 * rather than submitting an unprotected plan.
 */
export function encodePocV2Plan(
  opp: ArbOpportunity,
  options: {
    profitReceiver: Address;
    quotes: RawLegQuotes;
    costs: ExecutionCostsRaw;
    slippageBps: number;
    deadlineSeconds?: number;
    minNetProfitRaw?: bigint;
    minNetProfitBps?: number;
  },
): EncodedArbPlan {
  const { quotes, costs } = options;
  if (!quotes) throw new Error('quotes are required');
  if (!costs) throw new Error('execution costs are required');
  if (!Number.isInteger(options.slippageBps) || options.slippageBps < 0 || options.slippageBps >= 10_000) {
    throw new Error('slippageBps must be an integer from 0 through 9999');
  }

  const deadlineSeconds = options.deadlineSeconds ?? 60;
  if (
    !Number.isInteger(deadlineSeconds) ||
    deadlineSeconds < MIN_DEADLINE_SECONDS ||
    deadlineSeconds > MAX_DEADLINE_SECONDS
  ) {
    throw new Error(`deadlineSeconds must be an integer from ${MIN_DEADLINE_SECONDS} through ${MAX_DEADLINE_SECONDS}`);
  }

  requirePositive(quotes.blockNumber, 'quote blockNumber');
  requirePositive(quotes.firstLegAmountOutRaw, 'first-leg quote');
  requirePositive(quotes.secondLegAmountOutRaw, 'second-leg quote');
  requireNonNegative(costs.gasCostRaw, 'gasCostRaw');
  requireNonNegative(costs.l1FeeRaw, 'l1FeeRaw');
  requireNonNegative(costs.relayBidRaw, 'relayBidRaw');
  requireNonNegative(costs.safetyMarginRaw, 'safetyMarginRaw');
  if (quotes.blockNumber !== opp.blockNumber) {
    throw new Error(`quote blockNumber ${quotes.blockNumber} does not match opportunity snapshot ${opp.blockNumber}`);
  }

  const loanAmountRaw = opp.loanAmountRaw;
  requirePositive(loanAmountRaw, 'loanAmountRaw');
  const minIntermediateAmount = minAmountAfterSlippage(quotes.firstLegAmountOutRaw, options.slippageBps);
  const minFinalAmount = minAmountAfterSlippage(quotes.secondLegAmountOutRaw, options.slippageBps);
  if (minIntermediateAmount <= 0n) throw new Error('minIntermediateAmount must be greater than zero');
  if (minFinalAmount <= loanAmountRaw) {
    throw new Error('minFinalAmount must cover loanAmountRaw plus minProfitRaw');
  }
  const allExecutionCostsRaw = costs.gasCostRaw + costs.l1FeeRaw + costs.relayBidRaw;
  // Execution limits are derived exclusively from the two on-chain router quotes at
  // the pinned snapshot, including the same slippage protection as min-out. Scanner
  // USD prices remain discovery/TVL metadata only.
  const grossProfitRaw = quotes.secondLegAmountOutRaw - loanAmountRaw;
  const netProfitRaw = quotes.secondLegAmountOutRaw - loanAmountRaw - allExecutionCostsRaw - costs.safetyMarginRaw;
  const minProfitRaw = minFinalAmount - loanAmountRaw;
  requirePositive(grossProfitRaw, 'quoted gross profit');
  if (minProfitRaw < allExecutionCostsRaw + costs.safetyMarginRaw) {
    throw new Error('quoted gross profit must include gas, chain/L2 fees, and a safety margin');
  }
  const absoluteFloor = options.minNetProfitRaw ?? 0n;
  const minNetProfitBps = options.minNetProfitBps ?? 0;
  if (!Number.isInteger(minNetProfitBps) || minNetProfitBps < 0 || minNetProfitBps > 10_000) throw new Error('minNetProfitBps must be from 0 through 10000');
  const bpsFloor = (loanAmountRaw * BigInt(minNetProfitBps) + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;
  if (netProfitRaw < absoluteFloor) throw new Error(`net profit ${netProfitRaw} is below absolute floor ${absoluteFloor}`);
  if (netProfitRaw < bpsFloor) throw new Error(`net profit ${netProfitRaw} is below ${minNetProfitBps} bps capital floor ${bpsFloor}`);
  if (minFinalAmount < loanAmountRaw + minProfitRaw) {
    throw new Error('minFinalAmount must cover loanAmountRaw plus minProfitRaw');
  }

  const notes: string[] = [];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  if (opp.buyPool.toLowerCase() === opp.sellPool.toLowerCase() && opp.buyKind === opp.sellKind
      && (opp.buyKind !== 'aerodrome' || (opp.buyFactory?.toLowerCase() === opp.sellFactory?.toLowerCase()
        && opp.buyAeroStable === opp.sellAeroStable))) {
    notes.push('same venue/pool on both legs — POC v2 rejects this as InvalidRoute');
  }
  if (opp.buyKind === 'aerodrome' && !opp.buyFactory) {
    notes.push('Aerodrome buy leg missing factory');
  }
  if (opp.sellKind === 'aerodrome' && !opp.sellFactory) {
    notes.push('Aerodrome sell leg missing factory');
  }

  const executableByPocV2 = notes.length === 0;
  const calldata = encodeFunctionData({
    abi: pocV2Abi,
    functionName: 'executeArbitrage',
    args: [{
      loanToken: opp.loanToken,
      intermediateToken: opp.intermediateToken,
      firstLeg: { router: opp.buyRouter, pool: opp.buyPool, kind: kindToEnum(opp.buyKind), aeroStable: opp.buyAeroStable ?? false, aeroFactory: opp.buyFactory ?? '0x0000000000000000000000000000000000000000' },
      secondLeg: { router: opp.sellRouter, pool: opp.sellPool, kind: kindToEnum(opp.sellKind), aeroStable: opp.sellAeroStable ?? false, aeroFactory: opp.sellFactory ?? '0x0000000000000000000000000000000000000000' },
      loanAmount: loanAmountRaw,
      minIntermediateAmount,
      minFinalAmount,
      minProfit: minProfitRaw,
      deadline,
      profitReceiver: options.profitReceiver,
    }],
  });

  return { opportunity: opp, loanAmountRaw, minIntermediateAmount, minFinalAmount, minProfitRaw, deadline,
    profitReceiver: options.profitReceiver, calldata, costs, grossProfitRaw, netProfitRaw, executableByPocV2, notes };
}
