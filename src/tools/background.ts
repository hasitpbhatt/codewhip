import type { ToolContext, ToolResult } from "./types.js";
import { appendEntry } from "../audit.js";
import { sha256Hex } from "../hash.js";
import { commandGuard } from "./shell-guard.js";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENT,
  MAX_TIMEOUT_MS,
  MAX_WAIT_MS,
  MIN_TIMEOUT_MS,
  cap,
  getTask,
  killTask,
  spawn,
  taskCount,
  waitUntilDone,
} from "./background-tasks.js";

/**
 * Background task execution (doc D2 — the highest-leverage adoption): `bash`
 * is foreground-only and denies `&`/chaining, so a dev server or a 5-minute
 * test suite cannot run at all. These three tools fill the gap — spawn
 * detached, return a task id immediately, then read or stop it. The child runs
 * in the same cwd-jail under the SAME shell screen as `bash` (shared
 * `commandGuard`, so neither path can drift), and every spawn/read/stop writes
 * an audit entry under the run: adopted features deposit trust, not spend it.
 *
 * Process lifetime and the concurrency/output caps are `background-tasks.ts`,
 * the specs, arg guards and ToolDefs are `background-tools.ts`.
 */

function audit(ctx: ToolContext, tool: string, argsJson: string, result: string): void {
  const runId = ctx.runId ?? ctx.parentRunId ?? "unknown";
  try {
    appendEntry(ctx.cwd, {
      runId,
      actor: "policy",
      tool,
      args_hash: sha256Hex(argsJson),
      result_hash: sha256Hex(result.slice(0, 2000)),
      policy: "allow:background",
    });
  } catch {
    /* audit never throws into the tool path */
  }
}

export async function runInBackground(
  ctx: ToolContext,
  args: { command: string; timeoutMs?: number; waitMs?: number },
  _signal?: AbortSignal,
): Promise<ToolResult> {
  const command = args.command.trim();
  const refused = commandGuard(command);
  if (refused !== null) {
    return { ok: false, output: refused };
  }
  if (taskCount() >= MAX_CONCURRENT) {
    return { ok: false, output: `background: at the ${MAX_CONCURRENT}-task cap — stop one with task_stop before starting another` };
  }
  const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    return { ok: false, output: `background: timeoutMs must be an integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}` };
  }
  const state = spawn(ctx.cwd, command, timeout);
  const result = `started background task ${state.id} — use task_output id=${state.id} to read it, task_stop id=${state.id} to kill it`;
  audit(ctx, "run_in_background", JSON.stringify(args), result);
  // Optional foreground-wait handoff: block up to waitMs, then return status.
  if (args.waitMs !== undefined && Number.isInteger(args.waitMs) && args.waitMs > 0) {
    const wait = Math.min(args.waitMs, MAX_WAIT_MS);
    await waitUntilDone(state, args.waitMs);
    if (state.done) {
      return { ok: true, output: `${result}\n[completed within ${wait}ms] exit=${state.exitCode ?? "?"} output:\n${cap(state.output)}` };
    }
    return { ok: true, output: `${result}\n[still running after ${wait}ms — output so far:]\n${cap(state.output)}` };
  }
  return { ok: true, output: result };
}

export async function taskOutput(
  ctx: ToolContext,
  args: { id: string; blockMs?: number },
  _signal?: AbortSignal,
): Promise<ToolResult> {
  const state = getTask(args.id);
  if (state === undefined) {
    const out = `task_output: unknown task "${args.id}" (not running in this process)`;
    audit(ctx, "task_output", JSON.stringify(args), out);
    return { ok: false, output: out };
  }
  if (args.blockMs !== undefined && Number.isInteger(args.blockMs) && args.blockMs > 0) {
    await waitUntilDone(state, args.blockMs);
  }
  let status: string;
  if (!state.done) {
    status = `running (started ${new Date(state.startedTs).toISOString()})`;
  } else if (state.killed) {
    status = `killed`;
  } else if (state.timedOut) {
    status = `timed out after its timeout`;
  } else {
    status = `exited ${state.exitCode ?? "?"}`;
  }
  const out = `[${state.id} ${status}]\n${cap(state.output)}`;
  audit(ctx, "task_output", JSON.stringify(args), out);
  return { ok: true, output: out };
}

export async function taskStop(
  ctx: ToolContext,
  args: { id: string },
  _signal?: AbortSignal,
): Promise<ToolResult> {
  const state = getTask(args.id);
  if (state === undefined) {
    const out = `task_stop: unknown task "${args.id}" (not running in this process)`;
    audit(ctx, "task_stop", JSON.stringify(args), out);
    return { ok: false, output: out };
  }
  killTask(state);
  const out = `stopped ${state.id} (process tree killed)`;
  audit(ctx, "task_stop", JSON.stringify(args), out);
  return { ok: true, output: out };
}
