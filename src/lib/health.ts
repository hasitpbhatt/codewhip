/**
 * Health Tracking & Provider Analytics for CodeWhip Proxy
 * 
 * This module provides the complete health tracking system extracted from the CLI,
 * including call recording, summarization, and health reporting.
 */

// ============================================================================
// Types
// ============================================================================

export type ProviderCallOutcome =
  | "ok"
  | "auth"
  | "quota"
  | "timeout"
  | "network"
  | "bad_model"
  | "other";

export type ProviderCallRecord = {
  ts: string;
  provider: string;
  model: string;
  kind: "chat" | "models";
  outcome: ProviderCallOutcome;
  status?: number;
  host?: string;
  ms?: number;
  error?: string;
  /** Upstream-reported usage; absent on failures or usage-less upstreams. */
  promptTokens?: number;
  completionTokens?: number;
};

export type ModelHealth = {
  provider: string;
  model: string;
  total: number;
  ok: number;
  failed: number;
  successRate: number;
  lastFailureTs?: string;
  lastFailureOutcome?: ProviderCallOutcome;
  errorKinds: Record<string, number>;
  /** Sum of upstream-reported usage over ok calls (0 when none reported). */
  promptTokens: number;
  completionTokens: number;
  /** tokens/sec over ok calls that carry both tokens and latency. */
  tokensPerSec: number;
  /** Mean upstream latency (ms) over ok calls that report it. */
  avgMs: number;
};

export type ProviderHealth = {
  provider: string;
  total: number;
  ok: number;
  failed: number;
  successRate: number;
  models: ModelHealth[];
  promptTokens: number;
  completionTokens: number;
  tokensPerSec: number;
  avgMs: number;
};

export type ProviderHealthSummary = {
  providers: ProviderHealth[];
  total: number;
};

// ============================================================================
// Storage Interface for Health Records
// ============================================================================

export interface HealthStorage {
  append(record: ProviderCallRecord): Promise<void>;
  readAll(): Promise<ProviderCallRecord[]>;
}

// ============================================================================
// In-Memory Health Storage (for Workers/Serverless)
// ============================================================================

export class MemoryHealthStorage implements HealthStorage {
  private records: ProviderCallRecord[] = [];
  private maxRecords = 10000;

  async append(record: ProviderCallRecord): Promise<void> {
    this.records.push(record);
    // Keep only recent records
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }

  async readAll(): Promise<ProviderCallRecord[]> {
    return [...this.records];
  }
}

// ============================================================================
// Cloudflare KV Health Storage (for Workers)
// ============================================================================

export class KVHealthStorage implements HealthStorage {
  constructor(private kv: any) {}

  async append(record: ProviderCallRecord): Promise<void> {
    try {
      const key = `call_${record.provider}_${record.model}_${record.ts.replace(/[:.]/g, "-")}_${Math.random().toString(36).slice(2, 8)}`;
      await this.kv.put(key, JSON.stringify(record), { expirationTtl: 3600 * 24 * 7 }); // 1 week TTL
    } catch {
      // Health recording is best-effort
    }
  }

  async readAll(): Promise<ProviderCallRecord[]> {
    try {
      const keys = await this.kv.list({ prefix: "call_" });
      const records: ProviderCallRecord[] = [];
      for (const key of keys.keys) {
        const record = await this.kv.get(key.name, { type: "json" });
        if (record) records.push(record);
      }
      return records.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    } catch {
      return [];
    }
  }
}

// ============================================================================
// Health Summarization (Pure Functions)
// ============================================================================

/** Map an HTTP status to a coarse outcome bucket. */
export function outcomeForStatus(status: number): ProviderCallOutcome {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 404 || status === 410) return "bad_model";
  if (status >= 500) return "other";
  return "other";
}

/** Pure aggregation. Keyed by provider\u0000model — NUL never appears in an id,
 *  while model ids legitimately contain ":" (kilo:…:free). */
export function summarizeCalls(records: ProviderCallRecord[]): ProviderHealthSummary {
  const byKey = new Map<string, ProviderCallRecord[]>();
  for (const r of records) {
    const key = `${r.provider}\u0000${r.model}`;
    const entry = byKey.get(key);
    if (entry === undefined) byKey.set(key, [r]);
    else entry.push(r);
  }

  const providers = new Map<string, ProviderHealth>();
  const providerMs = new Map<string, { sum: number; n: number }>();
  for (const [key, recs] of byKey) {
    const [provider, model] = key.split("\u0000");
    let total = 0;
    let ok = 0;
    let failed = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let msWithTokens = 0;
    let msSum = 0;
    let msCount = 0;
    const errorKinds: Record<string, number> = {};
    let lastFailureTs: string | undefined;
    let lastFailureOutcome: ProviderCallOutcome | undefined;
    for (const r of recs) {
      total += 1;
      if (r.outcome === "ok") {
        ok += 1;
        if (typeof r.promptTokens === "number") promptTokens += r.promptTokens;
        if (typeof r.completionTokens === "number") completionTokens += r.completionTokens;
        if (typeof r.ms === "number" && (r.promptTokens !== undefined || r.completionTokens !== undefined)) {
          msWithTokens += r.ms;
        }
        if (typeof r.ms === "number") {
          msSum += r.ms;
          msCount += 1;
        }
      } else {
        failed += 1;
        errorKinds[r.outcome] = (errorKinds[r.outcome] ?? 0) + 1;
        if (lastFailureTs === undefined || r.ts > lastFailureTs) {
          lastFailureTs = r.ts;
          lastFailureOutcome = r.outcome;
        }
      }
    }
    const mh: ModelHealth = {
      provider,
      model,
      total,
      ok,
      failed,
      successRate: total === 0 ? 0 : ok / total,
      lastFailureTs,
      lastFailureOutcome,
      errorKinds,
      promptTokens,
      completionTokens,
      tokensPerSec: msWithTokens > 0 ? ((promptTokens + completionTokens) / msWithTokens) * 1000 : 0,
      avgMs: msCount > 0 ? msSum / msCount : 0,
    };
    let ph = providers.get(provider);
    if (ph === undefined) {
      ph = { provider, total: 0, ok: 0, failed: 0, successRate: 0, models: [], promptTokens: 0, completionTokens: 0, tokensPerSec: 0, avgMs: 0 };
      providers.set(provider, ph);
    }
    ph.total += total;
    ph.ok += ok;
    ph.failed += failed;
    ph.promptTokens += promptTokens;
    ph.completionTokens += completionTokens;
    const pms = providerMs.get(provider) ?? { sum: 0, n: 0 };
    pms.sum += msSum;
    pms.n += msCount;
    providerMs.set(provider, pms);
    ph.models.push(mh);
  }
  const out: ProviderHealth[] = [];
  for (const ph of providers.values()) {
    ph.successRate = ph.total === 0 ? 0 : ph.ok / ph.total;
    ph.tokensPerSec = ph.models.reduce((a, m) => a + m.tokensPerSec, 0);
    const pms = providerMs.get(ph.provider);
    ph.avgMs = pms !== undefined && pms.n > 0 ? pms.sum / pms.n : 0;
    ph.models.sort((a, b) => a.model.localeCompare(b.model));
    out.push(ph);
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return { providers: out, total: records.length };
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Model id used for `/models` listing checks — a check, not a model. */
export const LISTING_MODEL = "(listing)";

/** Render health summary as human-readable text. */
export function renderProviderHealth(s: ProviderHealthSummary, warnBelow = 0.8): string {
  if (s.total === 0) {
    return "provider health: no requests recorded yet (run a chat or list models).";
  }
  const lines: string[] = [`provider health: ${s.total} recorded calls`];
  for (const ph of s.providers) {
    const flag = ph.successRate < warnBelow ? "  ⚠ LOW" : "";
    const tok = ph.promptTokens + ph.completionTokens > 0 ? `  ${fmtTokens(ph.promptTokens + ph.completionTokens)} tok @ ${ph.tokensPerSec.toFixed(0)} tok/s` : "";
    lines.push(`  ${ph.provider}: ${(ph.successRate * 100).toFixed(0)}% ok (${ph.ok}/${ph.total})${flag}${tok}`);
    for (const mh of ph.models) {
      if (mh.model === LISTING_MODEL) {
        const last =
          mh.lastFailureOutcome !== undefined
            ? `  (last fail: ${mh.lastFailureOutcome} @ ${(mh.lastFailureTs ?? "?").slice(0, 19)})`
            : "";
        lines.push(`    · model-listing checks: ${(mh.successRate * 100).toFixed(0)}% (${mh.ok}/${mh.total})${last}`);
        continue;
      }
      const mflag = mh.successRate < warnBelow ? "  ⚠" : "";
      const last =
        mh.lastFailureOutcome !== undefined
          ? `  (last fail: ${mh.lastFailureOutcome} @ ${(mh.lastFailureTs ?? "?").slice(0, 19)})`
          : "";
      const mtok = mh.promptTokens + mh.completionTokens > 0 ? `  ${fmtTokens(mh.promptTokens + mh.completionTokens)} tok @ ${mh.tokensPerSec.toFixed(0)} tok/s` : "";
      lines.push(`    ${mh.model}: ${(mh.successRate * 100).toFixed(0)}% (${mh.ok}/${mh.total})${mtok}${mflag}${last}`);
    }
  }
  lines.push("legend: ⚠ = success rate below 80%. outcomes: ok/auth/quota/timeout/network/bad_model/other.");
  return lines.join("\n");
}

// ============================================================================
// Health Checker (for auto-routing)
// ============================================================================

const TTL_MS = {
  quota: 15 * 60 * 1000,
  auth: 60 * 60 * 1000,
  timeout: 5 * 60 * 1000,
  network: 5 * 60 * 1000,
  bad_model: 24 * 60 * 60 * 1000,
  other: 5 * 60 * 1000,
};

export function isRecentlyFailed(
  providerId: string, 
  model: string, 
  records: ProviderCallRecord[]
): boolean {
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return false;
  const mh = ph.models.find((m) => m.model === model);
  if (!mh || !mh.lastFailureTs || !mh.lastFailureOutcome) return false;
  const last = new Date(mh.lastFailureTs).getTime();
  const ttl = TTL_MS[mh.lastFailureOutcome as keyof typeof TTL_MS] ?? 5 * 60 * 1000;
  return Date.now() - last < ttl;
}

export function healthOk(
  providerId: string,
  model: string,
  records: ProviderCallRecord[]
): boolean {
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return true;
  const mh = ph.models.find((m) => m.model === model);
  if (!mh) return true;
  if (mh.total < 5) return true;
  return mh.successRate >= 0.7;
}

export function isUnhealthy(
  providerId: string,
  model: string,
  records: ProviderCallRecord[]
): boolean {
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return false;
  const mh = ph.models.find((m) => m.model === model);
  if (!mh) return false;
  if (mh.total < 5) return false;
  return mh.successRate < 0.5;
}

// ============================================================================
// Health Tracker Class (High-Level API)
// ============================================================================

export class HealthTracker {
  constructor(private storage: HealthStorage) {}

  async recordCall(
    provider: string,
    model: string,
    kind: "chat" | "models",
    outcome: ProviderCallOutcome,
    extra: Partial<ProviderCallRecord> = {}
  ): Promise<void> {
    const record: ProviderCallRecord = {
      ts: new Date().toISOString(),
      provider,
      model,
      kind,
      outcome,
      ...extra,
    };
    await this.storage.append(record);
  }

  async getSummary(): Promise<ProviderHealthSummary> {
    const records = await this.storage.readAll();
    return summarizeCalls(records);
  }

  async render(warnBelow = 0.8): Promise<string> {
    const summary = await this.getSummary();
    return renderProviderHealth(summary, warnBelow);
  }

  async isHealthy(provider: string, model: string): Promise<boolean> {
    const records = await this.storage.readAll();
    return healthOk(provider, model, records);
  }

  async isInTTL(provider: string, model: string): Promise<boolean> {
    const records = await this.storage.readAll();
    return isRecentlyFailed(provider, model, records);
  }
}