import type { ToolContext, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { findAgent, runChildAgent, MAX_DELEGATION_DEPTH } from "../subagents.js";

/**
 * The `delegate` tool: spawn one read-only subagent with a fresh context and
 * return its final report. Permission-wise delegation grants no new authority
 * (children are read/search/webfetch-only — already allow-class), so policy
 * allows it and every child call still lands on the audit chain under the
 * child's own runId. The depth guard lives in the loop (pre-ladder) AND here
 * (direct-call safety): children can never delegate.
 */

export const DELEGATE_TIMEOUT_MS = 600_000;
/** Keep the child's seed prompt sane. */
const MAX_TASK_CHARS = 8000;

function delegateSpec(): ToolSpec {
  return {
    name: "delegate",
    description:
      "Spawn a read-only subagent with a fresh context to investigate, review, or plan, and get its final report. " +
      "Args: agent (subagent name), task (self-contained instructions — the subagent sees nothing else). " +
      "Children can only read/search/webfetch and cannot delegate. 10-minute timeout.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string" },
        task: { type: "string" },
      },
      required: ["agent", "task"],
      additionalProperties: false,
    },
  };
}

function isDelegateArgs(args: unknown): args is { agent: string; task: string } {
  if (typeof args !== "object" || args === null) return false;
  const r = args as Record<string, unknown>;
  return typeof r["agent"] === "string" && r["agent"].length > 0 && typeof r["task"] === "string" && r["task"].length > 0;
}

function loopContextReady(ctx: ToolContext): ctx is ToolContext & { port: NonNullable<ToolContext["port"]>; model: string; label: string; depth: number } {
  return ctx.port !== undefined && typeof ctx.model === "string" && typeof ctx.label === "string" && typeof ctx.depth === "number";
}

export async function runDelegate(ctx: ToolContext, args: { agent: string; task: string }, signal?: AbortSignal): Promise<ToolResult> {
  if (!loopContextReady(ctx)) {
    return { ok: false, output: "delegate: only available inside an agent run (no provider context)" };
  }
  if (ctx.depth + 1 > MAX_DELEGATION_DEPTH) {
    return { ok: false, output: "delegate: subagents cannot delegate (depth cap)" };
  }
  const agent = findAgent(ctx.cwd, args.agent);
  if (agent === null) {
    return { ok: false, output: `delegate: unknown agent "${args.agent}"` };
  }
  if (args.task.length > MAX_TASK_CHARS) {
    return { ok: false, output: `delegate: task too long (${args.task.length} chars, max ${MAX_TASK_CHARS}) — split the work` };
  }
  const r = await runChildAgent({
    cwd: ctx.cwd,
    agent,
    task: args.task,
    port: ctx.port,
    model: ctx.model,
    label: ctx.label,
    depth: ctx.depth,
    signal,
    tokenBudget: ctx.remainingBudget,
    compactTokens: ctx.compactTokens,
    models: ctx.rotationModels,
    retryWait: ctx.retryWait,
    parentRunId: ctx.parentRunId,
    ...(ctx.onChildEvent === undefined ? {} : { onEvent: ctx.onChildEvent }),
  });
  ctx.onChildUsage?.(r.usageByModel);
  if (!r.ok) {
    return { ok: false, output: `subagent ${agent.name} failed: ${r.error}` };
  }
  return { ok: true, output: `${r.text}\n[subagent ${agent.name} runId: ${r.runId}]` };
}

export const delegateTool: ToolDef = {
  name: "delegate",
  spec: delegateSpec(),
  timeoutMs: DELEGATE_TIMEOUT_MS,
  exec: (ctx, args, signal) =>
    isDelegateArgs(args)
      ? runDelegate(ctx, args, signal)
      : Promise.resolve({ ok: false, output: "delegate: bad args (want agent, task)" } as ToolResult),
};
