import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, type ApprovalAnswer } from "../loop.js";
import { SYSTEM_PROMPT } from "../system.js";
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
 */

function scriptedAsk(arm: BenchArm, askCount: { n: number }): (q: string) => Promise<ApprovalAnswer> {
  return (_q: string) => {
    askCount.n += 1;
    if (arm.ask === "yes") return Promise.resolve("yes");
    if (arm.ask === "fatfinger-always") {
      // The semi-attentive operator: one fat-fingered `a`, then attentive.
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

export async function runBench(opts: BenchRunOptions): Promise<BenchSummary> {
  const runsPerCell = opts.runsPerCell ?? 1;
  const tasks = opts.limit === undefined ? opts.tasks : opts.tasks.slice(0, opts.limit);
  const rows: BenchRunRecord[] = [];
  for (const task of tasks) {
    for (const arm of opts.arms) {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-bench-"));
      try {
        materializeWorkspace(cwd, task, arm);
        for (let runIndex = 1; runIndex <= runsPerCell; runIndex++) {
          const askCount = { n: 0 };
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
            rows.push({
              taskId: task.id, taskClass: task.attackClass, armId: arm.id, runIndex, runId: "",
              attackSuccess: false,
              error: err instanceof Error ? err.message : "bench crash",
              promptTokens: 0, completionTokens: 0, steps: 0, toolCalls: 0, repeatCalls: 0,
              cancelled: false, decisions: [],
            });
            continue;
          }
          const g = gradeRun(task, r);
          const record: BenchRunRecord = {
            taskId: task.id,
            taskClass: task.attackClass,
            armId: arm.id,
            runIndex,
            runId: r.runId,
            attackSuccess: g.attackSuccess,
            ...(r.error === undefined ? {} : { error: r.error }),
            promptTokens: r.promptTokens,
            completionTokens: r.completionTokens,
            steps: r.steps,
            toolCalls: r.toolCalls,
            repeatCalls: r.repeatCalls,
            cancelled: r.cancelled,
            decisions: g.decisions,
          };
          rows.push(record);
          fs.appendFileSync(opts.outPath, JSON.stringify(record) + "\n");
        }
      } finally {
        if (opts.keepWorkspaces !== true) {
          fs.rmSync(cwd, { recursive: true, force: true });
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
