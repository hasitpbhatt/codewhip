import type { ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { MAX_WAIT_MS } from "./background-tasks.js";
import { runInBackground, taskOutput, taskStop } from "./background.js";

/**
 * The background tool family's registration layer: static arg guards, the
 * OpenAI-style specs (hand-written like registry.ts — zero deps), and the
 * ToolDefs the registry wires. The behaviour itself is in `background.js`.
 */

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
