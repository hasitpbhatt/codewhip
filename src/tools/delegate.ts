import type { ToolContext, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { canDelegate, findAgent, runChildAgent } from "../subagents.js";
import { allocateChildBudgets } from "../budget.js";

/**
 * The `delegate` tool: spawn one read-only subagent with a fresh context and
 * return its final report. Permission-wise delegation grants no new authority
 * (children are read/search-only — already allow-class, no network) so policy
 * allows it and every child call still lands on the audit chain under the
 * child's own runId. The depth guard lives in the loop (pre-ladder) AND here
 * (direct-call safety): children can never delegate. A per-child deadline
 * aborts the child's own signal so a timed-out child still settles, writes
 * its outcome, and folds its usage — never an orphan.
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
      "Children can only read/search (no network, no delegation). 10-minute timeout.",
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
  if (!canDelegate(ctx.depth)) {
    return { ok: false, output: "delegate: subagents cannot delegate (depth cap)" };
  }
  const agent = findAgent(ctx.cwd, args.agent);
  if (agent === null) {
    return { ok: false, output: `delegate: unknown agent "${args.agent}"` };
  }
  if (args.task.length > MAX_TASK_CHARS) {
    return { ok: false, output: `delegate: task too long (${args.task.length} chars, max ${MAX_TASK_CHARS}) — split the work` };
  }
  // Visible start (the child's own events follow, prefixed [agent]) so the
  // user never watches silent silence between provider turns.
  // Adaptive budget: single child gets 85% share, 15% reserved for parent collation.
  const budget = ctx.remainingBudget === undefined
    ? undefined
    : allocateChildBudgets(ctx.remainingBudget, 1);
  if (budget !== undefined) {
    ctx.onChildEvent?.(
      `[budget] parent=${budget.parentBudget} coord=${budget.coordinationBudget}` +
      ` child=${budget.children[0]?.allocated ?? 0} (85% share, 15% reserve)`
    );
  }
  ctx.onChildEvent?.(`[${agent.name}] started: ${args.task.slice(0, 120)}`);
  const r = await runChildAgent({
    cwd: ctx.cwd,
    agent,
    task: args.task,
    port: ctx.port,
    model: ctx.model,
    label: ctx.label,
    depth: ctx.depth,
    signal,
    tokenBudget: budget?.children[0]?.allocated,
    compactTokens: ctx.compactTokens,
    models: ctx.rotationModels,
    retryWait: ctx.retryWait,
    parentRunId: ctx.parentRunId,
    deadlineMs: DELEGATE_TIMEOUT_MS,
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
  // withTimeout is the net, not the mechanism: the per-child deadline
  // (DELEGATE_TIMEOUT_MS) aborts the child's own signal so it settles and
  // folds its usage; the net sits one buffer above so it essentially never
  // fires.
  timeoutMs: DELEGATE_TIMEOUT_MS + 60_000,
  exec: (ctx, args, signal) =>
    isDelegateArgs(args)
      ? runDelegate(ctx, args, signal)
      : Promise.resolve({ ok: false, output: "delegate: bad args (want agent, task)" } as ToolResult),
};
