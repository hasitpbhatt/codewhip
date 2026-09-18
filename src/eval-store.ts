import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Eval records — the machine-graded cousin of verdicts.jsonl.
 *
 * `codewhip eval` runs the agent against the fixture tasks in `tasks/` inside
 * disposable temp dirs and grades each attempt with the task's checker script.
 * Results land in `.codewhip/eval.jsonl` (one row per task run, latest per
 * task wins in aggregation) so the roadmap bars — task success ≥70% polish /
 * ≥50% implement — become measured numbers instead of aspirations. Human
 * verdicts (verdicts.jsonl) stay untouched: this file is checker output, and
 * the two are never mixed.
 *
 * Deliberately loop-free: metrics.ts imports this module, so it must not drag
 * the agent loop into its graph.
 */

export type EvalTaskClass = "polish" | "implement";

export type EvalRecord = {
  v: 1;
  ts: string;
  task: string;
  class: EvalTaskClass;
  pass: boolean;
  runId: string;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  steps: number;
  failovers: number;
  /** Checker output (trimmed) when the task failed; absent on pass. */
  reason?: string;
};

export function evalPath(cwd: string): string {
  return path.join(cwd, ".codewhip", "eval.jsonl");
}

export function isEvalTaskClass(x: unknown): x is EvalTaskClass {
  return x === "polish" || x === "implement";
}

/** Append one record. Never throws — a failed append must not fail the eval. */
export function appendEvalRecord(cwd: string, record: EvalRecord): boolean {
  try {
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    fs.appendFileSync(evalPath(cwd), JSON.stringify(record) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** All eval records, skipping malformed lines. Missing file = empty. */
export function readEvalRecords(cwd: string): EvalRecord[] {
  const out: EvalRecord[] = [];
  try {
    const raw = fs.readFileSync(evalPath(cwd), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const r = JSON.parse(line) as EvalRecord;
        if (r.v !== 1 || typeof r.task !== "string" || typeof r.pass !== "boolean") continue;
        if (!isEvalTaskClass(r.class)) continue;
        out.push(r);
      } catch { /* skip malformed */ }
    }
  } catch { /* missing file = no evals */ }
  return out;
}

export type ClassScore = { pass: number; total: number };

/**
 * Latest record per task wins (rerunning a task replaces its earlier result),
 * then aggregate per class. Bars from docs/moat/00-convergence.md:
 * polish ≥70%, implement ≥50%.
 */
export function summarizeEval(records: EvalRecord[]): { polish: ClassScore | null; implement: ClassScore | null } {
  const latest = new Map<string, EvalRecord>();
  for (const r of records) latest.set(r.task, r);
  const scores: Record<EvalTaskClass, ClassScore> = {
    polish: { pass: 0, total: 0 },
    implement: { pass: 0, total: 0 },
  };
  for (const r of latest.values()) {
    scores[r.class].total += 1;
    if (r.pass) scores[r.class].pass += 1;
  }
  return {
    polish: scores.polish.total > 0 ? scores.polish : null,
    implement: scores.implement.total > 0 ? scores.implement : null,
  };
}
