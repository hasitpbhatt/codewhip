import * as fs from "node:fs";
import type { BenchRunRecord } from "./types.js";

/**
 * Aggregation for the bench JSONL: per-arm attack-success rates overall and
 * per task class (RQ1/RQ2 tables), persistence deltas (run 2 vs run 1),
 * and resource tallies (RQ4/RQ5). Pure functions; the unit under test.
 */

export type ArmAgg = {
  runs: number;
  errors: number;
  attackTasks: number;
  attackSuccess: number;
  benignTasks: number;
  benignSuccess: number;
  benignBlocked: number;
  tokens: number;
  steps: number;
  repeatCalls: number;
  /** run-1 vs run-2+ attack-success on the same cells (persistence signal). */
  firstRunAttack: number;
  firstRunAttackTasks: number;
  laterRunAttack: number;
  laterRunAttackTasks: number;
};

export function aggregate(rows: BenchRunRecord[]): Map<string, ArmAgg> {
  const out = new Map<string, ArmAgg>();
  for (const r of rows) {
    const agg = (out.get(r.armId) ?? {
      runs: 0, errors: 0, attackTasks: 0, attackSuccess: 0, benignTasks: 0, benignSuccess: 0, benignBlocked: 0,
      tokens: 0, steps: 0, repeatCalls: 0,
      firstRunAttack: 0, firstRunAttackTasks: 0, laterRunAttack: 0, laterRunAttackTasks: 0,
    }) as ArmAgg;
    agg.runs += 1;
    agg.tokens += r.promptTokens + r.completionTokens;
    agg.steps += r.steps;
    agg.repeatCalls += r.repeatCalls;
    if (r.error !== undefined) {
      // Errored runs (provider 429s, crashes) are reported separately and
      // NEVER deflate the attack-success denominators — the error rate is
      // correlated with arm cost, so folding them in would bias the table.
      agg.errors += 1;
      out.set(r.armId, agg);
      continue;
    }
    if (r.taskClass !== "benign" && r.taskClass !== "cost-inflation") {
      agg.attackTasks += 1;
      if (r.attackSuccess) agg.attackSuccess += 1;
      if (r.runIndex === 1) {
        agg.firstRunAttackTasks += 1;
        if (r.attackSuccess) agg.firstRunAttack += 1;
      } else {
        agg.laterRunAttackTasks += 1;
        if (r.attackSuccess) agg.laterRunAttack += 1;
      }
    }
    if (r.taskClass === "benign") {
      agg.benignTasks += 1;
      // Utility (RQ4): completed with a non-empty answer.
      if (r.error === undefined && r.cancelled === false && r.textLength > 0) agg.benignSuccess += 1;
      // "Blocked" for a benign task = a deny decision anywhere in the run.
      if (r.decisions.some((d) => d.policy.startsWith("deny:"))) agg.benignBlocked += 1;
    }
    out.set(r.armId, agg);
  }
  return out;
}

function pct(n: number, d: number): string {
  return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

export function renderAnalysis(rows: BenchRunRecord[]): string {
  if (rows.length === 0) return "bench: no records.";
  const lines: string[] = [`bench: ${rows.length} runs`];
  lines.push("arm                       | attack succ | benign succ/blocked | run1→later | tokens | steps | repeats | errors");
  lines.push("--------------------------|-------------|---------------------|------------|--------|-------|---------|--------");
  for (const [arm, a] of [...aggregate(rows).entries()].sort()) {
    lines.push(
      `${arm.padEnd(25).slice(0, 25)} | ${pct(a.attackSuccess, a.attackTasks).padStart(10)} (${a.attackSuccess}/${a.attackTasks})` +
      ` | ${String(a.benignSuccess).padStart(5)}/${String(a.benignBlocked).padEnd(5)}` +
      ` | ${pct(a.firstRunAttack, a.firstRunAttackTasks)}→${pct(a.laterRunAttack, a.laterRunAttackTasks)}` +
      ` | ${String(a.tokens).padStart(6)} | ${String(a.steps).padStart(5)} | ${String(a.repeatCalls).padStart(7)} | ${String(a.errors).padStart(6)}`
    );
  }
  // Per-class breakdown (which attack classes escape which arm).
  const byClass = new Map<string, Map<string, { n: number; succ: number }>>();
  for (const r of rows) {
    if (r.taskClass === "benign" || r.taskClass === "cost-inflation") continue;
    const cls = byClass.get(r.taskClass) ?? new Map<string, { n: number; succ: number }>();
    const a = cls.get(r.armId) ?? { n: 0, succ: 0 };
    a.n += 1;
    if (r.attackSuccess) a.succ += 1;
    cls.set(r.armId, a);
    byClass.set(r.taskClass, cls);
  }
  for (const [cls, arms] of [...byClass.entries()].sort()) {
    const parts = [...arms.entries()].sort().map(([arm, a]) => `${arm}: ${a.succ}/${a.n}`);
    lines.push(`  ${cls}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

export function readRecords(paths: string[]): BenchRunRecord[] {
  const out: BenchRunRecord[] = [];
  for (const p of paths) {
    try {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          out.push(JSON.parse(line) as BenchRunRecord);
        } catch { /* skip malformed */ }
      }
    } catch { /* missing file */ }
  }
  return out;
}
