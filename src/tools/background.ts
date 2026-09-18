import { execFile, type ChildProcess } from "node:child_process";
import type { ToolContext, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { CHAIN_RX, matchDenylist, matchWorktreeEscape } from "../policy.js";
import { appendEntry } from "../audit.js";
import { sha256Hex } from "../hash.js";

/**
 * Background task execution (doc D2 — the highest-leverage adoption).
 *
 * `bash` is foreground-only and denies `&`/chaining, so a dev server or a
 * 5-minute test suite cannot run at all. These three tools fill that gap: a
 * command is spawned detached and returns a task id immediately; later calls
 * read its buffered output or stop it. The child runs in the same cwd-jail and
 * under the SAME denylist/CHAIN_RX/worktree-escape guards as `bash` — background
 * mode relaxes none of the safety surface.
 *
 * Lifetime: tasks are process-scoped, not persisted across runs (no restart on
 * resume). They are bounded in number and output so a runaway child can't drain
 * memory. Every spawn/read/stop writes an audit entry under the run — the doc
 * invariant: adopted features deposit trust, not spend it.
 */

const MAX_CONCURRENT = 8;
const MAX_OUTPUT_CHARS = 256 * 1024; // 256KB, like evot's spill cap
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1000;
/** Foreground-wait handoff window when the model asks to block briefly. */
const MAX_WAIT_MS = 60_000;

type TaskState = {
  id: string;
  command: string;
  startedTs: number;
  /** null while running; set on natural exit / kill. */
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  done: boolean;
  output: string;
  child: ChildProcess;
};

// Process-scoped manager. One per server/CLI process; cleared on restart.
const tasks = new Map<string, TaskState>();
let taskSeq = 0;

// Read-only snapshot for TUI polling. Returns only safe fields — no child
// process handles or internal state. Used by the TUI's 500ms background poll.
export type TaskStatus = {
  id: string;
  command: string;
  status: "running" | "done" | "error";
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  outputPreview: string;
};

export function getTaskStatuses(): TaskStatus[] {
  const out: TaskStatus[] = [];
  for (const [, state] of tasks) {
    out.push({
      id: state.id,
      command: state.command,
      status: state.timedOut ? "error" : state.done ? "done" : "running",
      exitCode: state.exitCode,
      killed: state.killed,
      timedOut: state.timedOut,
      outputPreview: state.output.slice(0, 200),
    });
  }
  return out;
}

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

function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…[output truncated at 256KB]" : s;
}

function guard(command: string): string | null {
  if (command.trim().length === 0) return "bash: missing required arg `command` (string)";
  if (command.length > 2000) return "bash: `command` too long (max 2000 chars)";
  const denied = matchDenylist(command);
  if (denied !== null) return `bash: denied by denylist:${denied} (non-overridable)`;
  if (CHAIN_RX.test(command)) {
    return "bash: shell chaining/statement separation is denied (newlines, ;, |, &, <, >, `, $())";
  }
  const escape = matchWorktreeEscape(command);
  if (escape !== null) return `bash: denied — ${escape} (non-overridable)`;
  return null;
}

function spawn(cwd: string, command: string, timeoutMs: number): TaskState {
  taskSeq += 1;
  const id = `task_${taskSeq}`;
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWin
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  const state: TaskState = {
    id,
    command,
    startedTs: Date.now(),
    exitCode: null,
    killed: false,
    timedOut: false,
    done: false,
    output: "",
    child: execFile(shell, shellArgs, { cwd, timeout: timeoutMs, maxBuffer: 512 * 1024, windowsHide: true }),
  };
  let buf = "";
  const append = (s: string): void => {
    buf += s;
    if (buf.length > MAX_OUTPUT_CHARS) buf = buf.slice(buf.length - MAX_OUTPUT_CHARS);
    state.output = buf;
  };
  state.child.stdout?.on("data", (d) => append(d.toString()));
  state.child.stderr?.on("data", (d) => append(d.toString()));
  state.child.on("error", (err) => append(`\n[error] ${err.message}`));
  state.child.on("close", (code, signal) => {
    state.exitCode = code;
    state.done = true;
    if (signal === "SIGTERM" || state.killed) state.killed = true;
  });
  state.child.on("exit", (code, signal) => {
    if (signal !== null && !state.killed && code === null) state.timedOut = true;
  });
  tasks.set(id, state);
  return state;
}

// === tool arg guards (static, zero-dep, mirrors bash.ts) ===

export function isRunInBackgroundArgs(x: unknown): x is { command: string; timeoutMs?: number; waitMs?: number } {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  if (typeof r["command"] !== "string") return false;
  if (r["timeoutMs"] !== undefined && typeof r["timeoutMs"] !== "number") return false;
  if (r["waitMs"] !== undefined && typeof r["waitMs"] !== "number") return false;
  return true;
}

export function isTaskOutputArgs(x: unknown): x is { id: string; blockMs?: number } {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r["id"] === "string" && r["id"].length > 0;
}

export function isTaskStopArgs(x: unknown): x is { id: string } {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r["id"] === "string" && r["id"].length > 0;
}

// === tool implementations ===

export async function runInBackground(
  ctx: ToolContext,
  args: { command: string; timeoutMs?: number; waitMs?: number },
  _signal?: AbortSignal,
): Promise<ToolResult> {
  const refused = guard(args.command);
  if (refused !== null) {
    return { ok: false, output: refused };
  }
  if (tasks.size >= MAX_CONCURRENT) {
    return { ok: false, output: `background: at the ${MAX_CONCURRENT}-task cap — stop one with task_stop before starting another` };
  }
  const timeout = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    return { ok: false, output: `background: timeoutMs must be an integer ${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}` };
  }
  const state = spawn(ctx.cwd, args.command, timeout);
  const result = `started background task ${state.id} — use task_output id=${state.id} to read it, task_stop id=${state.id} to kill it`;
  audit(ctx, "run_in_background", JSON.stringify(args), result);
  // Optional foreground-wait handoff: block up to waitMs, then return status.
  if (args.waitMs !== undefined && Number.isInteger(args.waitMs) && args.waitMs > 0) {
    const wait = Math.min(args.waitMs, MAX_WAIT_MS);
    const deadline = Date.now() + wait;
    while (!state.done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(() => r(undefined), 50));
    }
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
  const state = tasks.get(args.id);
  if (state === undefined) {
    const out = `task_output: unknown task "${args.id}" (not running in this process)`;
    audit(ctx, "task_output", JSON.stringify(args), out);
    return { ok: false, output: out };
  }
  if (args.blockMs !== undefined && Number.isInteger(args.blockMs) && args.blockMs > 0 && !state.done) {
    const wait = Math.min(args.blockMs, MAX_WAIT_MS);
    const deadline = Date.now() + wait;
    while (!state.done && Date.now() < deadline) {
      await new Promise((r) => setTimeout(() => r(undefined), 50));
    }
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
  const state = tasks.get(args.id);
  if (state === undefined) {
    const out = `task_stop: unknown task "${args.id}" (not running in this process)`;
    audit(ctx, "task_stop", JSON.stringify(args), out);
    return { ok: false, output: out };
  }
  state.killed = true;
  if (!state.child.killed) {
    state.child.kill("SIGTERM");
  }
  const out = `sent SIGTERM to ${state.id}`;
  audit(ctx, "task_stop", JSON.stringify(args), out);
  return { ok: true, output: out };
}

// === tool specs (OpenAI-style, mirrors registry.ts) ===

function runInBackgroundSpec(): ToolSpec {
  return {
    name: "run_in_background",
    description:
      "Start a shell command detached; returns a task id at once so the run continues. " +
      "Use for long jobs (dev servers, test suites, builds). Read output with task_output id=<id>, stop with task_stop id=<id>. " +
      "Same denylist/chain/worktree guards as bash apply. Args: command, optional timeoutMs (1000..120000), optional waitMs (block up to 60s then report).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
        waitMs: { type: "integer", minimum: 1, maximum: 60000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

function taskOutputSpec(): ToolSpec {
  return {
    name: "task_output",
    description: "Read a background task's accumulated output and status. Args: id (from run_in_background), optional blockMs (wait up to 60s for completion).",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        blockMs: { type: "integer", minimum: 1, maximum: 60000 },
      },
      required: ["id"],
      additionalProperties: false,
    },
  };
}

function taskStopSpec(): ToolSpec {
  return {
    name: "task_stop",
    description: "Stop a running background task by id (SIGTERM). Args: id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  };
}

export const runInBackgroundTool: ToolDef = {
  name: "run_in_background",
  spec: runInBackgroundSpec(),
  timeoutMs: MAX_WAIT_MS + 60_000,
  exec: (ctx, args, signal) =>
    isRunInBackgroundArgs(args) ? runInBackground(ctx, args, signal) : Promise.resolve({ ok: false, output: "run_in_background: bad args (want command)" } as ToolResult),
};

export const taskOutputTool: ToolDef = {
  name: "task_output",
  spec: taskOutputSpec(),
  timeoutMs: MAX_WAIT_MS + 10_000,
  exec: (ctx, args, signal) =>
    isTaskOutputArgs(args) ? taskOutput(ctx, args, signal) : Promise.resolve({ ok: false, output: "task_output: bad args (want id)" } as ToolResult),
};

export const taskStopTool: ToolDef = {
  name: "task_stop",
  spec: taskStopSpec(),
  timeoutMs: 10_000,
  exec: (ctx, args, signal) =>
    isTaskStopArgs(args) ? taskStop(ctx, args, signal) : Promise.resolve({ ok: false, output: "task_stop: bad args (want id)" } as ToolResult),
};
