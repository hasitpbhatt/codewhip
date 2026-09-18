import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { agentLoop } from "./loop.js";
import { readOutcomeRecords, appendOutcome } from "./outcomes.js";
import {
  appendEvalRecord,
  isEvalTaskClass,
  type EvalRecord,
  type EvalTaskClass,
} from "./eval-store.js";
import type { ChatPort } from "./provider-port.js";

/**
 * Eval runner: the agent loop measured against the fixture tasks in `tasks/`.
 *
 * Each task is a tiny repo fixture (setup files + a checker script + a prompt).
 * The runner copies the fixture into a disposable temp dir, runs agentLoop
 * headless there (yolo — the temp dir IS the sandbox, denylist still applies),
 * grades with the checker (`node check.mjs <fixtureDir>`, exit 0 = pass), then
 * merges the run's outcome record into the host `.codewhip/outcomes.jsonl` and
 * appends an eval record. The temp dir is deleted unless keepTemp — which also
 * deletes that run's local audit trail, acceptable for fixtures, never for
 * user code.
 */

export type EvalTask = {
  name: string;
  class: EvalTaskClass;
  prompt: string;
  dir: string;
};

export type EvalTaskError = { name: string; error: string };

export type ListedTasks = { tasks: EvalTask[]; errors: EvalTaskError[] };

export const EVAL_TASKS_DIR = "tasks";

/** List fixture tasks under `tasksRoot` (a `task.json` per directory). */
export function listEvalTasks(tasksRoot: string, only?: string): ListedTasks {
  const tasks: EvalTask[] = [];
  const errors: EvalTaskError[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(tasksRoot).filter((n) => {
      try {
        return fs.statSync(path.join(tasksRoot, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return { tasks, errors: [{ name: "*", error: `no tasks directory at ${tasksRoot}` }] };
  }
  for (const name of names) {
    if (only !== undefined && name !== only) continue;
    const dir = path.join(tasksRoot, name);
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, "task.json"), "utf8")) as {
        name?: unknown;
        class?: unknown;
        prompt?: unknown;
      };
      if (typeof meta.name !== "string" || meta.name !== name) {
        errors.push({ name, error: "task.json name missing or does not match the directory" });
        continue;
      }
      if (!isEvalTaskClass(meta.class)) {
        errors.push({ name, error: 'task.json class must be "polish" or "implement"' });
        continue;
      }
      if (typeof meta.prompt !== "string" || meta.prompt.trim().length === 0) {
        errors.push({ name, error: "task.json prompt missing" });
        continue;
      }
      if (!fs.existsSync(path.join(dir, "check.mjs"))) {
        errors.push({ name, error: "check.mjs missing" });
        continue;
      }
      const setup = path.join(dir, "setup");
      if (!fs.existsSync(setup) || fs.statSync(setup).isDirectory() === false) {
        errors.push({ name, error: "setup/ directory missing" });
        continue;
      }
      tasks.push({ name, class: meta.class, prompt: meta.prompt, dir });
    } catch (err) {
      errors.push({ name, error: err instanceof Error ? err.message : "unreadable task.json" });
    }
  }
  return { tasks, errors };
}

/** Recursive copy of the fixture's setup tree into the temp dir. */
function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

export type RunEvalOpts = {
  tasksRoot: string;
  /** Host repo cwd — where eval.jsonl and the merged outcomes land. */
  cwd: string;
  only?: string;
  port: ChatPort;
  provider: string;
  model: string;
  maxSteps: number;
  tokenBudget?: number;
  /** Wall clock per task (ms). The provider's own timeouts bound each call. */
  taskTimeoutMs: number;
  keepTemp: boolean;
  onLog: (line: string) => void;
};

export type TaskResult = EvalRecord & { durationMs: number };

export type RunEvalResult = {
  results: TaskResult[];
  setupErrors: EvalTaskError[];
};

/** Run every (selected) task. Never throws per task — failures become rows. */
export async function runEval(opts: RunEvalOpts): Promise<RunEvalResult> {
  const { tasks, errors } = listEvalTasks(opts.tasksRoot, opts.only);
  const results: TaskResult[] = [];
  for (const task of tasks) {
    opts.onLog(`── ${task.name} [${task.class}] ──`);
    const t0 = Date.now();
    const rec = await runOneTask(task, opts);
    rec.durationMs = Date.now() - t0;
    results.push(rec);
    appendEvalRecord(opts.cwd, rec);
    opts.onLog(
      rec.pass
        ? `   PASS ${rec.runId.slice(0, 8)} · ${rec.promptTokens}+${rec.completionTokens} tok · ${rec.steps} steps · ${(rec.durationMs / 1000).toFixed(1)}s`
        : `   FAIL ${rec.runId.slice(0, 8)} · ${rec.reason ?? "checker failed"}`
    );
  }
  return { results, setupErrors: errors };
}

async function runOneTask(task: EvalTask, opts: RunEvalOpts): Promise<TaskResult> {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-eval-"));
  try {
    copyTree(path.join(task.dir, "setup"), temp);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`task timeout after ${opts.taskTimeoutMs}ms`)), opts.taskTimeoutMs);
    let result;
    try {
      result = await agentLoop({
        prompt: task.prompt,
        model: opts.model,
        label: opts.provider,
        cwd: temp,
        maxSteps: opts.maxSteps,
        yolo: true, // disposable fixture dir — the denylist still applies
        stdinIsTTY: true,
        port: opts.port,
        signal: ctrl.signal,
        askUser: async () => "no", // eval must never need a human; fail closed
        remembered: [], // host remembered rules must not leak into eval runs
        tokenBudget: opts.tokenBudget,
        onEvent: (e) => opts.onLog(`   · ${e.text}`),
      });
    } finally {
      clearTimeout(timer);
    }
    // Grade: checker runs OUTSIDE the fixture (the agent cannot edit it) and
    // receives the fixture dir as argv[2].
    const check = spawnSync(process.execPath, [path.join(task.dir, "check.mjs"), temp], {
      timeout: 30_000,
      encoding: "utf8",
    });
    const pass = check.status === 0;
    const checkerReason = pass
      ? null
      : `checker exit ${check.status ?? "signal"}: ${((check.stdout ?? "") + (check.stderr ?? "")).trim().slice(0, 300)}`;
    const reasons = [result.error, checkerReason].filter((x): x is string => typeof x === "string" && x.length > 0);
    // Merge the run's outcome rows into the host repo (runId ties them to
    // this eval row) before the temp dir — and its local audit trail — goes.
    for (const row of readOutcomeRecords(temp)) {
      appendOutcome(opts.cwd, row);
    }
    const primary = result.usageByModel[0];
    return {
      v: 1,
      ts: new Date().toISOString(),
      task: task.name,
      class: task.class,
      pass,
      runId: result.runId,
      provider: primary?.label ?? opts.provider,
      model: primary?.model ?? opts.model,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      steps: result.steps,
      failovers: result.failovers.length,
      ...(reasons.length > 0 ? { reason: reasons.join("; ").slice(0, 500) } : {}),
      durationMs: 0,
    };
  } finally {
    if (!opts.keepTemp) {
      try {
        fs.rmSync(temp, { recursive: true, force: true });
      } catch { /* best effort */ }
    } else {
      opts.onLog(`   (temp kept: ${temp})`);
    }
  }
}
