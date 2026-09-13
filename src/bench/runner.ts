import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, type ApprovalAnswer } from "../loop.js";
import { SYSTEM_PROMPT } from "../system.js";
import { POLICY_VERSION } from "../policy.js";
import { listRules } from "../remember-store.js";
import type { BenchArm, BenchRunOptions, BenchRunRecord, BenchSummary, BenchTask } from "./types.js";
import { gradeRun } from "./grade.js";

/**
 * Batch runner: task×arm×run cells over the real agentLoop seam. Each cell
 * gets a generated temp workspace (files materialized, policy.md written for
 * harness arms); runs 2..N of a cell REUSE the workspace so persisted state
 * (remembered rules, minted denies) binds later runs — the RQ2 persistence
 * measurement. Records stream to the JSONL as they land; a crashed cell
 * records its error and never blocks the batch.
 *
 * Validity guarantees (engineers panel, 2026-09-13):
 * - the scripted operator spans the whole CELL (one fat-finger per cell) —
 *   per-run resets would measure re-success, not persistence;
 * - arms are fail-closed: a "prompt"-surface arm without rule text throws
 *   before any cell runs (otherwise the harness silently drops its denies);
 * - reruns dedupe against existing (task, arm, run) rows in the out file;
 * - manifest fields (ts/model/label/policyVersion) ride every record.
 */

function scriptedAsk(arm: BenchArm, askCount: { n: number }): (q: string) => Promise<ApprovalAnswer> {
  return (_q: string) => {
    askCount.n += 1;
    if (arm.ask === "yes") return Promise.resolve("yes");
    if (arm.ask === "fatfinger-always") {
      // The semi-attentive operator: one fat-fingered `a` per CELL, then
      // attentive for the rest of the cell (all runs).
      return Promise.resolve(askCount.n === 1 ? "always" : "no");
    }
    return Promise.resolve("no");
  };
}

function materializeWorkspace(cwd: string, task: BenchTask, arm: BenchArm): void {
  for (const [rel, content] of Object.entries(task.files)) {
    const p = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (arm.workspacePolicy !== undefined) {
    fs.writeFileSync(path.join(cwd, "policy.md"), arm.workspacePolicy + "\n");
  }
}

function rmWorkspace(cwd: string): void {
  // Windows EBUSY can beat a just-closed subprocess handle; one retry.
  try {
    fs.rmSync(cwd, { recursive: true, force: true });
  } catch {
    setTimeout(() => {
      try {
        fs.rmSync(cwd, { recursive: true, force: true });
      } catch { /* leave for OS temp cleanup */ }
    }, 200).unref?.();
  }
}

function existingCells(outPath: string): Set<string> {
  const done = new Set<string>();
  try {
    for (const line of fs.readFileSync(outPath, "utf8").split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const r = JSON.parse(line) as BenchRunRecord;
        done.add(`${r.taskId}|${r.armId}|${r.runIndex}`);
      } catch { /* skip malformed */ }
    }
  } catch { /* fresh file */ }
  return done;
}

export async function runBench(opts: BenchRunOptions): Promise<BenchSummary> {
  // Fail-closed arms: a prompt-surface arm without rule text would silently
  // run with NO denies harness-side and NO rules in the prompt — the worst
  // possible measurement. Refuse before touching a workspace.
  for (const arm of opts.arms) {
    if (arm.policySurface === "prompt" && (arm.promptPolicyRules === undefined || arm.promptPolicyRules.trim().length === 0)) {
      throw new Error(`bench: arm "${arm.id}" sets policySurface "prompt" without promptPolicyRules — refuse to run ungoverned`);
    }
  }
  const runsPerCell = opts.runsPerCell ?? 1;
  const tasks = opts.limit === undefined ? opts.tasks : opts.tasks.slice(0, opts.limit);
  const done = existingCells(opts.outPath);
  const rows: BenchRunRecord[] = [];
  for (const task of tasks) {
    for (const arm of opts.arms) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-bench-"));
      try {
        materializeWorkspace(cwd, task, arm);
        // The scripted operator spans the WHOLE cell (all runs share one
        // askCount): one fat-finger per cell, attentive after. Resetting per
        // run would measure per-session re-success, not persistence.
        const askCount = { n: 0 };
        for (let runIndex = 1; runIndex <= runsPerCell; runIndex++) {
          const cellKey = `${task.id}|${arm.id}|${runIndex}`;
          if (done.has(cellKey)) continue; // rerun dedupe
          const systemPrompt =
            arm.policySurface === "prompt" && arm.promptPolicyRules !== undefined
              ? `${SYSTEM_PROMPT}\n\n${arm.promptPolicyRules}`
              : undefined;
          let r;
          try {
            r = await agentLoop({
              prompt: task.prompt,
              model: opts.model,
              label: opts.label,
              cwd,
              maxSteps: arm.maxSteps ?? 12,
              yolo: arm.yolo ?? false,
              // The bench simulates an interactive operator: stdinIsTTY must
              // be true or the ask ladder holds every ask without consulting
              // the scripted askUser.
              stdinIsTTY: true,
              port: opts.port,
              askUser: scriptedAsk(arm, askCount),
              remembered: listRules(cwd),
              policySurface: arm.policySurface,
              repeatGuard: arm.repeatGuard,
              tokenBudget: arm.tokenBudget,
              systemPrompt,
            });
          } catch (err) {
            // agentLoop never throws by contract; belt for bench bugs.
            rows.push(benchErrorRecord(task, arm, runIndex, err instanceof Error ? err.message : "bench crash", opts));
            continue;
          }
          const g = gradeRun(task, r);
          const record: BenchRunRecord = {
            taskId: task.id,
            taskClass: task.attackClass,
            armId: arm.id,
            runIndex,
            runId: r.runId,
            ts: new Date().toISOString(),
            model: opts.model,
            label: opts.label,
            policyVersion: POLICY_VERSION,
            attackSuccess: g.attackSuccess,
            ...(r.error === undefined ? {} : { error: r.error }),
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            steps: r.steps,
            toolCalls: r.toolCalls,
            repeatCalls: r.repeatCalls,
            cancelled: r.cancelled,
            textLength: r.text.length,
            decisions: g.decisions,
          };
          rows.push(record);
          fs.appendFileSync(opts.outPath, JSON.stringify(record) + "\n");
        }
      } finally {
        if (opts.keepWorkspaces !== true) {
          rmWorkspace(cwd);
        }
      }
    }
  }
  const byArm: BenchSummary["byArm"] = {};
  for (const row of rows) {
    const agg = (byArm[row.armId] ??= { runs: 0, attackSuccess: 0, tokens: 0, steps: 0 });
    agg.runs += 1;
    if (row.attackSuccess) agg.attackSuccess += 1;
    agg.tokens += row.promptTokens + row.completionTokens;
    agg.steps += row.steps;
  }
  return { runs: rows.length, byArm };
}

function benchErrorRecord(task: BenchTask, arm: BenchArm, runIndex: number, error: string, opts: BenchRunOptions): BenchRunRecord {
  return {
    taskId: task.id, taskClass: task.attackClass, armId: arm.id, runIndex, runId: "",
    ts: new Date().toISOString(), model: opts.model, label: opts.label,
    policyVersion: POLICY_VERSION,
    attackSuccess: false,
    error,
    promptTokens: 0, completionTokens: 0, steps: 0, toolCalls: 0, repeatCalls: 0,
    cancelled: false, textLength: 0, decisions: [],
  };
}
