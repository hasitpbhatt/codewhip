import type { ToolContext, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { canDelegate, findAgent, runChildAgent } from "../subagents.js";
import { DELEGATE_TIMEOUT_MS } from "./delegate.js";

/**
 * The `delegate_many` tool: fan one task out to several read-only subagents
 * concurrently (capped) and return their ordered reports — the multi-perspective
 * exploration/convergence case. Results return in entry order regardless of
 * completion order; each child's usage folds into the parent's receipt. The
 * fan-out's aggregate budget is honest: the remaining budget is SPLIT across
 * entries (each child enforces its share live), not handed whole to every
 * child. Per-child deadlines mean a slow child costs only itself — finished,
 * paid-for reports are returned, never discarded.
 */

export const MAX_FANOUT = 4;
const MAX_TASK_CHARS = 8000;

type Entry = { agent: string; task: string };

function delegateManySpec(): ToolSpec {
  return {
    name: "delegate_many",
    description:
      `Fan a task out to ${MAX_FANOUT} read-only subagents at most, concurrently, and get their reports in order. ` +
      "Args: entries (array of {agent, task}) — use different agents for independent perspectives, then converge on the results. " +
      "Children can only read/search/webfetch and cannot delegate.",
    parameters: {
      type: "object",
      properties: {
        entries: {
          type: "array",
          minItems: 1,
          maxItems: MAX_FANOUT,
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              task: { type: "string" },
            },
            required: ["agent", "task"],
            additionalProperties: false,
          },
        },
      },
      required: ["entries"],
      additionalProperties: false,
    },
  };
}

function isEntries(args: unknown): args is { entries: Entry[] } {
  if (typeof args !== "object" || args === null) return false;
  const r = args as Record<string, unknown>;
  if (!Array.isArray(r["entries"]) || r["entries"].length === 0) return false;
  return (r["entries"] as unknown[]).every((e) => {
    if (typeof e !== "object" || e === null) return false;
    const x = e as Record<string, unknown>;
    return typeof x["agent"] === "string" && x["agent"].length > 0 && typeof x["task"] === "string" && x["task"].length > 0;
  });
}

function loopContextReady(ctx: ToolContext): ctx is ToolContext & { port: NonNullable<ToolContext["port"]>; model: string; label: string; depth: number } {
  return ctx.port !== undefined && typeof ctx.model === "string" && typeof ctx.label === "string" && typeof ctx.depth === "number";
}

export async function runDelegateMany(ctx: ToolContext, args: { entries: Entry[] }, signal?: AbortSignal): Promise<ToolResult> {
  if (!loopContextReady(ctx)) {
    return { ok: false, output: "delegate_many: only available inside an agent run (no provider context)" };
  }
  if (!canDelegate(ctx.depth)) {
    return { ok: false, output: "delegate_many: subagents cannot delegate (depth cap)" };
  }
  if (args.entries.length > MAX_FANOUT) {
    return { ok: false, output: `delegate_many: at most ${MAX_FANOUT} entries (got ${args.entries.length})` };
  }
  const entries = args.entries;
  const agents: Array<{ name: string; def: NonNullable<ReturnType<typeof findAgent>>; task: string }> = [];
  for (const e of entries) {
    if (e.task.length > MAX_TASK_CHARS) {
      return { ok: false, output: `delegate_many: task for "${e.agent}" too long (${e.task.length} chars, max ${MAX_TASK_CHARS})` };
    }
    const def = findAgent(ctx.cwd, e.agent);
    if (def === null) {
      return { ok: false, output: `delegate_many: unknown agent "${e.agent}"` };
    }
    agents.push({ name: def.name, def, task: e.task });
  }
  // Aggregate-budget honesty: the parent's remaining budget is split across
  // the fan-out — each child enforces its share live (per-child budget),
  // so N concurrent children cannot overspend N x remaining.
  const share = ctx.remainingBudget === undefined ? undefined : Math.max(1, Math.floor(ctx.remainingBudget / agents.length));
  for (const { name, task } of agents) {
    ctx.onChildEvent?.(`[${name}] started: ${task.slice(0, 120)}`);
  }
  const runs = await Promise.all(
    agents.map(({ def, task }) =>
      runChildAgent({
        cwd: ctx.cwd,
        agent: def,
        task,
        port: ctx.port,
        model: ctx.model,
        label: ctx.label,
        depth: ctx.depth,
        signal,
        tokenBudget: share,
        compactTokens: ctx.compactTokens,
        models: ctx.rotationModels,
        retryWait: ctx.retryWait,
        parentRunId: ctx.parentRunId,
        deadlineMs: DELEGATE_TIMEOUT_MS,
        ...(ctx.onChildEvent === undefined ? {} : { onEvent: ctx.onChildEvent }),
      })
    )
  );
  const lines: string[] = [];
  const runIds: string[] = [];
  let failed = 0;
  runs.forEach((r, i) => {
    ctx.onChildUsage?.(r.usageByModel);
    const name = agents[i]?.name ?? `agent${i + 1}`;
    if (r.ok) {
      runIds.push(r.runId);
      lines.push(`#${i + 1} [${name}]\n${r.text}`);
    } else {
      failed += 1;
      lines.push(`#${i + 1} [${name}] FAILED: ${r.error}`);
    }
  });
  const tail = runIds.length > 0 ? `\n[subagent runIds: ${runIds.join(", ")}]` : "";
  return { ok: failed < runs.length, output: lines.join("\n\n") + tail };
}

export const delegateManyTool: ToolDef = {
  name: "delegate_many",
  spec: delegateManySpec(),
  // Net above the per-child deadline (see delegateTool) so per-child aborts
  // settle and fold usage before the tool-level net could ever fire.
  timeoutMs: DELEGATE_TIMEOUT_MS + 60_000,
  exec: (ctx, args, signal) =>
    isEntries(args)
      ? runDelegateMany(ctx, args, signal)
      : Promise.resolve({ ok: false, output: `delegate_many: bad args (want entries: 1..${MAX_FANOUT} of {agent, task})` } as ToolResult),
};
