import { estimateCost } from "./router.js";
import { listRules } from "./remember-store.js";
import { readOutcomeRecords, type OutcomeRecord } from "./outcomes.js";
import { readVerdictMap } from "./verdict.js";
import type { ProviderId } from "./provider.js";

export type MetricsSummary = {
  runs: number;
  periodStart: string | null;
  periodEnd: string | null;
  toolCalls: number;
  allowed: number;
  denied: number;
  /** Deny-fires per 100 runs (roadmap bar: ≥5 in demo, 0 jail escapes). */
  blocksPer100: number;
  /** Priced spend only; untracked routes are counted, never fiction-priced. */
  pricedCost: number;
  pricedRuns: number;
  untrackedRuns: number;
  memoryLines: number;
  memoryPerWeek: number;
  /** Human verdicts joined from verdicts.jsonl (latest per runId wins). */
  verdicts: number;
  accepted: number;
  edited: number;
  reverted: number;
  rejected: number;
  /** accepted / verdicts; null when no verdicts yet. */
  successRate: number | null;
};

export function loadOutcomeRecords(cwd: string): OutcomeRecord[] {
  return readOutcomeRecords(cwd);
}

/** Pure aggregation — the unit under test. `nowMs` injects the clock. */
export function summarize(records: OutcomeRecord[], memoryLines: number, oldestMemoryTs: string | null, nowMs: number): MetricsSummary {
  let toolCalls = 0;
  let allowed = 0;
  let denied = 0;
  let pricedCost = 0;
  let pricedRuns = 0;
  let untrackedRuns = 0;
  let accepted = 0;
  let edited = 0;
  let reverted = 0;
  let rejected = 0;
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  for (const r of records) {
    if (periodStart === null || r.ts < periodStart) periodStart = r.ts;
    if (periodEnd === null || r.ts > periodEnd) periodEnd = r.ts;
    for (const c of r.tool_calls ?? []) {
      toolCalls += 1;
      if (c.decision === "deny") denied += 1;
      else allowed += 1;
    }
    if (r.verdict !== null && r.verdict !== undefined) {
      if (r.verdict === "accepted") accepted += 1;
      else if (r.verdict === "edited") edited += 1;
      else if (r.verdict === "reverted") reverted += 1;
      else if (r.verdict === "rejected") rejected += 1;
    }
    const buckets = r.usageByModel ?? [];
    if (buckets.length === 0) {
      untrackedRuns += 1;
      continue;
    }
    let runCost = 0;
    let priced = false;
    for (const b of buckets) {
      const c = estimateCost(b.label as ProviderId, b.model, b.prompt, b.completion);
      if (c !== null) {
        runCost += c;
        priced = true;
      }
    }
    if (priced) {
      pricedCost += runCost;
      pricedRuns += 1;
    } else {
      untrackedRuns += 1;
    }
  }
  let memoryPerWeek = 0;
  if (memoryLines > 0 && oldestMemoryTs !== null) {
    const spanMs = nowMs - Date.parse(oldestMemoryTs);
    if (Number.isFinite(spanMs) && spanMs >= 0) {
      const weeks = Math.max(1 / 7, spanMs / (7 * 24 * 3600 * 1000));
      memoryPerWeek = memoryLines / weeks;
    }
  }
  return {
    runs: records.length,
    periodStart,
    periodEnd,
    toolCalls,
    allowed,
    denied,
    blocksPer100: records.length === 0 ? 0 : (denied / records.length) * 100,
    pricedCost,
    pricedRuns,
    untrackedRuns,
    memoryLines,
    memoryPerWeek,
    verdicts: accepted + edited + reverted + rejected,
    accepted,
    edited,
    reverted,
    rejected,
    successRate: accepted + edited + reverted + rejected === 0 ? null : accepted / (accepted + edited + reverted + rejected),
  };
}

export function summarizeCwd(cwd: string, nowMs: number = Date.now()): MetricsSummary {
  const records = loadOutcomeRecords(cwd);
  // Join the verdict sidecar (latest per runId wins) without mutating outcomes v1.
  const vmap = readVerdictMap(cwd);
  if (vmap.size > 0) {
    for (const r of records) {
      const v = vmap.get(r.runId);
      if (v !== undefined) r.verdict = v.verdict;
    }
  }
  const rules = listRules(cwd);
  const validTs = rules.map((r) => r.ts).filter((t) => Number.isFinite(Date.parse(t))).sort();
  const oldest = validTs.length === 0 ? null : (validTs[0] as string);
  return summarize(records, rules.length, oldest, nowMs);
}

export function renderMetrics(s: MetricsSummary): string {
  if (s.runs === 0) {
    return "metrics: no runs yet (.codewhip/outcomes.jsonl missing or empty).";
  }
  const lines = [
    `metrics: ${s.runs} runs, ${s.toolCalls} tool calls (${s.periodStart?.slice(0, 10) ?? "?"} → ${s.periodEnd?.slice(0, 10) ?? "?"})`,
    `  decisions: ${s.allowed} allow / ${s.denied} deny → ${s.blocksPer100.toFixed(1)} blocks/100 runs (bar: ≥5 in demo; jail escapes need audit --verify)`,
    s.pricedRuns > 0
      ? `  spend: $${s.pricedCost.toFixed(4)} across ${s.pricedRuns} priced runs ($${(s.pricedCost / s.pricedRuns).toFixed(4)}/task) + ${s.untrackedRuns} untracked`
      : `  spend: untracked on all ${s.runs} runs (no priced provider:model in mix)`,
    `  memory: ${s.memoryLines} lines, ${s.memoryPerWeek.toFixed(1)}/week (bar: +3–5 durable lines/repo/week)`,
    s.verdicts === 0 || s.successRate === null
      ? `  task success: unmeasurable — no verdicts recorded yet (bar: ≥70% polish / ≥50% implement)`
      : `  task success: ${(s.successRate * 100).toFixed(0)}% accepted (${s.accepted}/${s.verdicts} verdicts: ${s.edited} edited, ${s.reverted} reverted, ${s.rejected} rejected)`,
  ];
  return lines.join("\n");
}