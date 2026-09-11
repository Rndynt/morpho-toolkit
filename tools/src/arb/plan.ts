import { encodeFunctionData, parseAbi, parseUnits, type Hex } from 'viem';
import type { Address } from '../config/registry.js';
import type { ArbOpportunity } from './scanner.js';
import type { VenueKind } from './routes.js';

const pocV2Abi = parseAbi([
  'function executeArbitrage((address loanToken, address intermediateToken, (address router, uint8 kind, bool aeroStable, address aeroFactory) firstLeg, (address router, uint8 kind, bool aeroStable, address aeroFactory) secondLeg, uint256 loanAmount, uint256 minIntermediateAmount, uint256 minFinalAmount, uint256 minProfit, uint256 deadline, address profitReceiver) params) returns (uint256 profit)',
]);

export type EncodedArbPlan = {
  opportunity: ArbOpportunity;
  loanAmountRaw: bigint;
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

function parseLoanAmount(opp: ArbOpportunity): bigint {
  return parseUnits(opp.loanAmountFormatted, opp.loanTokenDecimals);
}

export function encodePocV2Plan(
  opp: ArbOpportunity,
  options: {
    profitReceiver: Address;
    deadlineSeconds?: number;
    minProfitBps?: number;
    minIntermediateAmount?: bigint;
    minFinalAmount?: bigint;
  },
): EncodedArbPlan {
  const notes: string[] = [];
  const loanAmountRaw = parseLoanAmount(opp);
  const minProfitBps = options.minProfitBps ?? 5_000;
  const gross = Number(opp.grossProfitFormatted);
  const minProfitHuman = Math.max(0, (gross * minProfitBps) / 10_000);
  const minProfitRaw = parseUnits(minProfitHuman.toFixed(Math.min(6, opp.loanTokenDecimals)), opp.loanTokenDecimals);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + (options.deadlineSeconds ?? 300));

  if (opp.buyRouter.toLowerCase() === opp.sellRouter.toLowerCase()) {
    notes.push('same router on both legs \u2014 POC v2 rejects this as InvalidRoute');
  }
  if (opp.buyKind === 'aerodrome' && !opp.buyFactory) {
    notes.push('Aerodrome buy leg missing factory');
  }
  if (opp.sellKind === 'aerodrome' && !opp.sellFactory) {
    notes.push('Aerodrome sell leg missing factory');
  }

  const executableByPocV2 = notes.length === 0 && loanAmountRaw > 0n;

  const calldata = encodeFunctionData({
    abi: pocV2Abi,
    functionName: 'executeArbitrage',
    args: [
      {
        loanToken: opp.loanToken,
        intermediateToken: opp.intermediateToken,
        firstLeg: {
          router: opp.buyRouter,
          kind: kindToEnum(opp.buyKind),
          aeroStable: false,
          aeroFactory: opp.buyFactory ?? '0x0000000000000000000000000000000000000000',
        },
        secondLeg: {
          router: opp.sellRouter,
          kind: kindToEnum(opp.sellKind),
          aeroStable: false,
          aeroFactory: opp.sellFactory ?? '0x0000000000000000000000000000000000000000',
        },
        loanAmount: loanAmountRaw,
        minIntermediateAmount: options.minIntermediateAmount ?? 0n,
        minFinalAmount: options.minFinalAmount ?? 0n,
        minProfit: minProfitRaw,
        deadline,
        profitReceiver: options.profitReceiver,
      },
    ],
  });

  return {
    opportunity: opp,
    loanAmountRaw,
    minProfitRaw,
    deadline,
    profitReceiver: options.profitReceiver,
    calldata,
    executableByPocV2,
    notes,
  };
}
