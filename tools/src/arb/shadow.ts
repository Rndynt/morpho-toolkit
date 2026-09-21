import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ShadowRecord = {
  schemaVersion: 1;
  candidateId: string;
  observedAt: string;
  chainId: number;
  /** Stable venue identifier used to enforce readiness independently per route segment. */
  venue: string;
  candidate: unknown;
  quote: { blockNumber: string; amountOutRaw: string; expiresAt: string };
  simulation: { safe: boolean; latencyMs: number; reason?: string };
  hypotheticalInclusionBlock: string;
  realizedOutputRaw: string | null;
  /** Principal that must be returned to the flash-loan provider. */
  loanPrincipalRaw: string;
  /** Production safety buffer, denominated in the loan token. */
  safetyMarginRaw: string;
  totalCostsRaw: string;
};

export type ShadowMetricValues = {
  samples: number;
  observedFrom: string | null;
  observedTo: string | null;
  observationSpanMs: number;
  unsafeSimulations: number;
  falsePositiveRate: number;
  quoteToInclusionSuccessRate: number;
  latencyMs: { p50: number; p95: number };
  quoteDecayBps: { p50: number; p95: number };
  netProfitRaw: { p05: bigint; p50: bigint; p95: bigint };
};

export type ShadowMetrics = ShadowMetricValues & {
  segments: readonly { chainId: number; venue: string; metrics: ShadowMetricValues }[];
};

const rank = (length: number, p: number): number => Math.max(0, Math.ceil(length * p) - 1);
const percentile = (values: number[], p: number): number => values.length === 0 ? 0 : values.sort((a, b) => a - b)[rank(values.length, p)]!;
const percentileBigInt = (values: bigint[], p: number): bigint => values.length === 0 ? 0n : values.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)[rank(values.length, p)]!;

/** Append-only JSONL sink. It intentionally exposes no signer or broadcast method. */
export class ShadowStore {
  constructor(readonly path: string) {}
  async append(record: ShadowRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
  async read(): Promise<ShadowRecord[]> {
    try { return (await readFile(this.path, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as ShadowRecord); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}

export type ShadowProbe = {
  observe(): Promise<Omit<ShadowRecord, 'schemaVersion' | 'observedAt'>>;
};

/** Runs one read-only observation at a time; schedule it with cron/systemd for days. */
export class ShadowRunner {
  constructor(private readonly probe: ShadowProbe, private readonly store: ShadowStore, private readonly now = () => new Date()) {}
  async runOnce(): Promise<ShadowRecord> {
    const observed = await this.probe.observe();
    const record: ShadowRecord = { schemaVersion: 1, observedAt: this.now().toISOString(), ...observed };
    await this.store.append(record);
    return record;
  }
}

function measureValues(records: readonly ShadowRecord[]): ShadowMetricValues {
  const completed = records.filter((r) => r.realizedOutputRaw !== null);
  const netProfit = (r: ShadowRecord): bigint => BigInt(r.realizedOutputRaw!) - BigInt(r.loanPrincipalRaw) - BigInt(r.totalCostsRaw) - BigInt(r.safetyMarginRaw);
  const falsePositives = records.filter((r) => r.simulation.safe && (r.realizedOutputRaw === null || netProfit(r) <= 0n));
  const decay = completed.map((r) => {
    const quote = BigInt(r.quote.amountOutRaw); const realized = BigInt(r.realizedOutputRaw!);
    return Number(((quote - realized) * 10_000n) / quote);
  });
  const profits = completed.map(netProfit);
  const latencies = records.map((r) => r.simulation.latencyMs);
  const observedTimes = records.map((r) => Date.parse(r.observedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const observedFrom = observedTimes.length ? new Date(observedTimes[0]!).toISOString() : null;
  const observedTo = observedTimes.length ? new Date(observedTimes.at(-1)!).toISOString() : null;
  return {
    samples: records.length,
    observedFrom,
    observedTo,
    observationSpanMs: observedTimes.length === records.length && observedTimes.length > 1 ? observedTimes.at(-1)! - observedTimes[0]! : 0,
    unsafeSimulations: records.filter((r) => !r.simulation.safe).length,
    falsePositiveRate: records.length ? falsePositives.length / records.length : 0,
    quoteToInclusionSuccessRate: records.length ? completed.length / records.length : 0,
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95) },
    quoteDecayBps: { p50: percentile(decay, .5), p95: percentile(decay, .95) },
    netProfitRaw: { p05: percentileBigInt(profits, .05), p50: percentileBigInt(profits, .5), p95: percentileBigInt(profits, .95) },
  };
}

export function measureShadow(records: readonly ShadowRecord[]): ShadowMetrics {
  const grouped = new Map<string, ShadowRecord[]>();
  for (const record of records) {
    const key = `${record.chainId}:${record.venue}`;
    const segment = grouped.get(key) ?? [];
    segment.push(record);
    grouped.set(key, segment);
  }
  return {
    ...measureValues(records),
    segments: [...grouped.values()].map((segment) => ({ chainId: segment[0]!.chainId, venue: segment[0]!.venue, metrics: measureValues(segment) })),
  };
}

export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
export type AcceptanceCriteria = {
  minimumSamples: number;
  minimumSuccessRate: number;
  minimumP05NetProfitRaw: bigint;
  minimumObservationSpanMs?: number;
  /** Complete production matrix; an unobserved chain/venue fails closed. */
  requiredSegments: readonly { chainId: number; venue: string }[];
};
export function assessMainnet(metrics: ShadowMetrics, criteria: AcceptanceCriteria): { accepted: boolean; failures: string[] } {
  const failures: string[] = [];
  const minimumSpan = criteria.minimumObservationSpanMs ?? SEVEN_DAYS_MS;
  const assess = (values: ShadowMetricValues, label: string): void => {
    if (values.samples < criteria.minimumSamples) failures.push(`${label} requires ${criteria.minimumSamples} samples, got ${values.samples}`);
    if (values.observationSpanMs < minimumSpan) failures.push(`${label} observation span is below ${minimumSpan}ms`);
    if (values.unsafeSimulations !== 0) failures.push(`${label} unsafe simulations must be zero`);
    if (values.quoteToInclusionSuccessRate < criteria.minimumSuccessRate) failures.push(`${label} quote-to-inclusion success rate is below minimum`);
    if (values.netProfitRaw.p05 < criteria.minimumP05NetProfitRaw) failures.push(`${label} p05 net profit after principal, safety margin, and all costs is below minimum`);
  };
  assess(metrics, 'global');
  const presentSegments = new Set(metrics.segments.map((segment) => `${segment.chainId}:${segment.venue}`));
  for (const required of criteria.requiredSegments) {
    if (!presentSegments.has(`${required.chainId}:${required.venue}`)) failures.push(`missing required chain ${required.chainId} venue ${required.venue} segment`);
  }
  for (const segment of metrics.segments) assess(segment.metrics, `chain ${segment.chainId} venue ${segment.venue}`);
  return { accepted: failures.length === 0, failures };
}
