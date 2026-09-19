import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";

/**
 * Per-(provider, model) request health. Codewhip records every chat/models call
 * (success or specific failure kind) so a user can see which models/providers are
 * actually usable and avoid ones that consistently fail. Chat successes also
 * carry the upstream-reported token usage, so stats can show real throughput
 * (tokens and tokens/sec), not just success counts. Pure aggregation is unit
 * tested; the file side-effect is best-effort and never breaks a run.
 */

export type ProviderCallKind = "chat" | "models";

/** Coarse failure buckets — the "what went wrong" the user cares about. */
export type ProviderCallOutcome =
  | "ok"
  | "auth" // 401/403 — key rejected by this host
  | "quota" // 429 — rate limited
  | "balance_low" // 402 — insufficient balance/credits
  | "timeout"
  | "network"
  | "bad_model" // 404/410 — retired/unknown model
  | "other";

export type ProviderCallRecord = {
  ts: string; // ISO timestamp
  provider: string;
  model: string; // chat model id, or LISTING_MODEL for a models call
  kind: ProviderCallKind;
  outcome: ProviderCallOutcome;
  status?: number;
  host?: string;
  ms?: number;
  error?: string; // truncated; never contains a key
  /** Upstream-reported usage; absent on failures or usage-less upstreams. */
  promptTokens?: number;
  completionTokens?: number;
};

/** Model id used for `/models` listing checks — a check, not a model. */
export const LISTING_MODEL = "(listing)";

/**
 * Recency window for auto-pick health gating: candidates are judged on their
 * last N calls before their lifetime record, so recovery is immediate instead
 * of waiting for lifetime dilution that an excluded model can never earn.
 */
export const RECENT_WINDOW = 20;

const FILE = "provider-analytics.jsonl";

function filePath(): string {
  return path.join(configDir(), FILE);
}

// ---------------------------------------------------------------------------
// Buffered write + cached read — avoids a sync syscall per request.
//
// write: records are appended to an in-memory buffer. A flush writes them to
//        disk every 5 seconds (or on process exit). This turns N per-request
//        appendFileSync calls into one every 5 seconds.
//
// read:  the parsed array is cached and only re-read from disk when the
//        dirty flag is set (a write happened since the last read). The first
//        read is a cold-start disk load.
// ---------------------------------------------------------------------------

let writeBuffer: string[] = [];
let dirty = false;
let cached: ProviderCallRecord[] | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let dirEnsured = false;

function flushSync(): void {
  if (writeBuffer.length === 0) return;
  try {
    if (!dirEnsured) {
      fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
      dirEnsured = true;
    }
    fs.appendFileSync(filePath(), writeBuffer.join(""), { mode: 0o600 });
    writeBuffer = [];
  } catch {
    // analytics is best-effort
  }
}

function startFlushTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => flushSync(), 5000);
  // Unref so the timer doesn't keep the process alive.
  if (typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
  process.on("exit", flushSync);
}

/** Append-only record. Never throws — analytics must not break a run. */
export function recordProviderCall(rec: ProviderCallRecord): void {
  try {
    writeBuffer.push(JSON.stringify(rec) + "\n");
    dirty = true;
    startFlushTimer();
  } catch {
    // analytics is best-effort
  }
}

export function readProviderCalls(): ProviderCallRecord[] {
  if (cached !== null && !dirty) return cached;
  try {
    // Cold start or dirty: load from disk.
    if (writeBuffer.length > 0) flushSync();
    const raw = fs.readFileSync(filePath(), "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    cached = lines.map((l, i) => {
      try {
        return JSON.parse(l) as ProviderCallRecord;
      } catch (err) {
        // Torn tail: a crash mid-append leaves a partial LAST line — drop it
        // and keep the rest. A corrupt middle line still throws to the outer
        // catch, because silently resuming past interior damage hides it.
        if (i === lines.length - 1) return null;
        throw err;
      }
    }).filter((r): r is ProviderCallRecord => r !== null);
    dirty = false;
    return cached;
  } catch {
    cached = [];
    dirty = false;
    return cached;
  }
}

/** Map an HTTP status to a coarse outcome bucket. Pass body to detect "balance low" from 402 responses. */
export function outcomeForStatus(status: number, body?: string): ProviderCallOutcome {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 402 && body !== undefined && /balance/i.test(body)) return "balance_low";
  if (status === 402) return "quota";
  if (status === 404 || status === 410) return "bad_model";
  if (status >= 500) return "other";
  return "other";
}

export type ModelHealth = {
  provider: string;
  model: string;
  total: number;
  ok: number;
  failed: number;
  successRate: number; // 0..1
  /** ISO ts of the newest recorded call (any outcome) — staleness input. */
  lastCallTs?: string;
  /** Rolling last-RECENT_WINDOW calls — the recency view auto gates on. */
  recentOk: number;
  recentTotal: number;
  recentSuccessRate: number; // 0..1
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
  successRate: number; // 0..1
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

/**
 * Pure aggregation (the unit under test). Keyed by provider + model — the key
 * separator is a \u0000 escape because neither a provider id nor a model id can
 * contain NUL, while model ids legitimately contain ":" (kilo:…:free).
 */
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
    // Rolling recency window (chronological by ts — append order is normally
    // already chronological; the sort pins it against clock skew).
    const recent = [...recs]
      .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0))
      .slice(-RECENT_WINDOW);
    const recentOk = recent.filter((r) => r.outcome === "ok").length;
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
      lastCallTs: recs.reduce<string | undefined>((max, r) => (max === undefined || r.ts > max ? r.ts : max), undefined),
      recentOk,
      recentTotal: recent.length,
      recentSuccessRate: recent.length === 0 ? 0 : recentOk / recent.length,
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

export function renderProviderHealth(s: ProviderHealthSummary, warnBelow = 0.8): string {
  if (s.total === 0) {
    return "provider health: no requests recorded yet (run a chat or `codewhip models <provider>`).";
  }
  const lines: string[] = [`provider health: ${s.total} recorded calls`];
  for (const ph of s.providers) {
    const flag = ph.successRate < warnBelow ? "  ⚠ LOW" : "";
    const tok = ph.promptTokens + ph.completionTokens > 0 ? `  ${fmtTokens(ph.promptTokens + ph.completionTokens)} tok @ ${ph.tokensPerSec.toFixed(0)} tok/s` : "";
    lines.push(`  ${ph.provider}: ${(ph.successRate * 100).toFixed(0)}% ok (${ph.ok}/${ph.total})${flag}${tok}`);
    for (const mh of ph.models) {
      if (mh.model === LISTING_MODEL) {
        // A models-listing check is not a model; don't render it as one.
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
