import { encodeFunctionData, parseAbi, type Hex } from 'viem';
import type { Address } from '../config/registry.js';
import type { ArbOpportunity } from './scanner.js';
import type { VenueKind } from './routes.js';

const pocV2Abi = parseAbi([
  'function executeArbitrage((address loanToken, address intermediateToken, (address router, uint8 kind, bool aeroStable, address aeroFactory) firstLeg, (address router, uint8 kind, bool aeroStable, address aeroFactory) secondLeg, uint256 loanAmount, uint256 minIntermediateAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
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
  /** Chain/L2 execution fee denominated in the loan token. */
  chainFeeRaw: bigint;
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
  executableByPocV2: boolean;
  notes: string[];
};

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
  requireNonNegative(costs.chainFeeRaw, 'chainFeeRaw');
  requireNonNegative(costs.safetyMarginRaw, 'safetyMarginRaw');
  requirePositive(opp.grossProfitRaw, 'grossProfitRaw');

  const loanAmountRaw = opp.loanAmountRaw;
  requirePositive(loanAmountRaw, 'loanAmountRaw');
  const minIntermediateAmount = minAmountAfterSlippage(quotes.firstLegAmountOutRaw, options.slippageBps);
  const minFinalAmount = minAmountAfterSlippage(quotes.secondLegAmountOutRaw, options.slippageBps);
  const requiredCostsRaw = costs.gasCostRaw + costs.chainFeeRaw + costs.safetyMarginRaw;
  const minProfitRaw = opp.grossProfitRaw;
  if (minProfitRaw < requiredCostsRaw) {
    throw new Error('grossProfitRaw must include gas, chain/L2 fees, and a safety margin');
  }
  if (minIntermediateAmount <= 0n) throw new Error('minIntermediateAmount must be greater than zero');
  if (minFinalAmount < loanAmountRaw + minProfitRaw) {
    throw new Error('minFinalAmount must cover loanAmountRaw plus minProfitRaw');
  }

  const notes: string[] = [];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSeconds);

  if (opp.buyRouter.toLowerCase() === opp.sellRouter.toLowerCase()) {
    notes.push('same router on both legs — POC v2 rejects this as InvalidRoute');
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
      firstLeg: { router: opp.buyRouter, kind: kindToEnum(opp.buyKind), aeroStable: opp.buyAeroStable ?? false, aeroFactory: opp.buyFactory ?? '0x0000000000000000000000000000000000000000' },
      secondLeg: { router: opp.sellRouter, kind: kindToEnum(opp.sellKind), aeroStable: opp.sellAeroStable ?? false, aeroFactory: opp.sellFactory ?? '0x0000000000000000000000000000000000000000' },
      loanAmount: loanAmountRaw,
      minIntermediateAmount,
      minFinalAmount,
      minProfit: minProfitRaw,
      deadline,
      profitReceiver: options.profitReceiver,
    }],
  });

  return { opportunity: opp, loanAmountRaw, minIntermediateAmount, minFinalAmount, minProfitRaw, deadline, profitReceiver: options.profitReceiver, calldata, executableByPocV2, notes };
}
