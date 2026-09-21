import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type ShadowRecord = {
  schemaVersion: 1;
  candidateId: string;
  observedAt: string;
  chainId: number;
  candidate: unknown;
  quote: { blockNumber: string; amountOutRaw: string; expiresAt: string };
  simulation: { safe: boolean; latencyMs: number; reason?: string };
  hypotheticalInclusionBlock: string;
  realizedOutputRaw: string | null;
  totalCostsRaw: string;
};

export type ShadowMetrics = {
  samples: number;
  unsafeSimulations: number;
  falsePositiveRate: number;
  quoteToInclusionSuccessRate: number;
  latencyMs: { p50: number; p95: number };
  quoteDecayBps: { p50: number; p95: number };
  netProfitRaw: { p05: bigint; p50: bigint; p95: bigint };
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

export function measureShadow(records: readonly ShadowRecord[]): ShadowMetrics {
  const completed = records.filter((r) => r.realizedOutputRaw !== null);
  const falsePositives = records.filter((r) => r.simulation.safe && (r.realizedOutputRaw === null || BigInt(r.realizedOutputRaw) <= BigInt(r.totalCostsRaw)));
  const decay = completed.map((r) => {
    const quote = BigInt(r.quote.amountOutRaw); const realized = BigInt(r.realizedOutputRaw!);
    return Number(((quote - realized) * 10_000n) / quote);
  });
  const profits = completed.map((r) => BigInt(r.realizedOutputRaw!) - BigInt(r.totalCostsRaw));
  const latencies = records.map((r) => r.simulation.latencyMs);
  return {
    samples: records.length,
    unsafeSimulations: records.filter((r) => !r.simulation.safe).length,
    falsePositiveRate: records.length ? falsePositives.length / records.length : 0,
    quoteToInclusionSuccessRate: records.length ? completed.length / records.length : 0,
    latencyMs: { p50: percentile(latencies, .5), p95: percentile(latencies, .95) },
    quoteDecayBps: { p50: percentile(decay, .5), p95: percentile(decay, .95) },
    netProfitRaw: { p05: percentileBigInt(profits, .05), p50: percentileBigInt(profits, .5), p95: percentileBigInt(profits, .95) },
  };
}

export type AcceptanceCriteria = { minimumSamples: number; minimumSuccessRate: number; minimumP05NetProfitRaw: bigint };
export function assessMainnet(metrics: ShadowMetrics, criteria: AcceptanceCriteria): { accepted: boolean; failures: string[] } {
  const failures: string[] = [];
  if (metrics.samples < criteria.minimumSamples) failures.push(`requires ${criteria.minimumSamples} samples, got ${metrics.samples}`);
  if (metrics.unsafeSimulations !== 0) failures.push('unsafe simulations must be zero');
  if (metrics.quoteToInclusionSuccessRate < criteria.minimumSuccessRate) failures.push('quote-to-inclusion success rate is below minimum');
  if (metrics.netProfitRaw.p05 < criteria.minimumP05NetProfitRaw) failures.push('p05 net profit after all costs is below minimum');
  return { accepted: failures.length === 0, failures };
}
