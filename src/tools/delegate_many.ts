import type { ToolContext, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { canDelegate, findAgent } from "../subagents.js";
import { DELEGATE_TIMEOUT_MS } from "./delegate.js";
import { allocateChildBudgets } from "../budget.js";
import { MAX_TASK_CHARS, loopContextReady, runChild } from "./child-run.js";

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

type Entry = { agent: string; task: string };

function delegateManySpec(): ToolSpec {
  return {
    name: "delegate_many",
    description:
      `Fan a task out to ${MAX_FANOUT} read-only subagents at most, concurrently, and get their reports in order. ` +
      "Args: entries (array of {agent, task}) — use different agents for independent perspectives, then converge on the results. " +
      "Children can only read/search (no network, no delegation).",
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
    const def = findAgent(ctx.cwd, e.agent, ctx.agents);
    if (def === null) {
      return { ok: false, output: `delegate_many: unknown agent "${e.agent}"` };
    }
    agents.push({ name: def.name, def, task: e.task });
  }
  // Adaptive budget allocation: split remaining budget across children with
  // an 85% child share and 15% coordination reserve so parent can collate
  // after fan-out. Each child enforces its allocated share live.
  const budget = ctx.remainingBudget === undefined
    ? undefined
    : allocateChildBudgets(ctx.remainingBudget, agents.length);
  // The visible start is unconditional. It used to sit inside the
  // `budget !== undefined` branch, so a fan-out on a run without a token
  // budget started several children with nothing between the last event and
  // the first report — the exact "silent silence" the line exists to prevent.
  for (const { name, task } of agents) {
    ctx.onChildEvent?.(`[${name}] started: ${task.slice(0, 120)}`);
  }
  // `allocated === 0` is the split saying "the pool cannot fund this child".
  // Running it anyway is how four children once drew four tokens out of a
  // two-token pool, so a zero is dropped — and named, because a silently
  // dropped perspective is the unaccountable outcome this codebase refuses.
  const dropped = agents.filter((_, i) => budget?.children[i]?.allocated === 0);
  if (dropped.length > 0) {
    ctx.onChildEvent?.(
      `[budget] dropped ${dropped.length} child(ren): ${dropped.map((d) => d.name).join(", ")} — each allocated 0 of the parent's remaining pool (${ctx.remainingBudget})`
    );
  }
  const runnable = agents
    .map((a, i) => ({ entry: a, index: i, tokens: budget?.children[i]?.allocated }))
    .filter((r) => r.tokens === undefined || r.tokens > 0);
  if (runnable.length === 0) {
    return {
      ok: false,
      output: `delegate_many: the parent's remaining token pool (${ctx.remainingBudget}) cannot fund any child (each allocated 0) — spend fewer steps, raise --token-budget, or do the work in this run`,
    };
  }
  if (budget !== undefined) {
    ctx.onChildEvent?.(
      `[budget] parent=${budget.parentBudget} coord=${budget.coordinationBudget}` +
      ` children=${runnable.reduce((s, r) => s + (r.tokens ?? 0), 0)} (${runnable.length} of ${agents.length} children, 85% share, 15% reserve)`
    );
  }
  const runs = await Promise.all(
    runnable.map((r) =>
      runChild(ctx, {
        agent: r.entry.def,
        task: r.entry.task,
        signal,
        tokenBudget: r.tokens,
        deadlineMs: DELEGATE_TIMEOUT_MS,
      })
    )
  );
  const lines: string[] = [];
  const runIds: string[] = [];
  let failed = 0;
  runs.forEach((r, k) => {
    ctx.onChildUsage?.(r.usageByModel);
    const name = runnable[k]?.entry.name ?? `agent${k + 1}`;
    const slot = runnable[k]?.index ?? k;
    if (r.ok) {
      runIds.push(r.runId);
      lines.push(`#${slot + 1} [${name}]\n${r.text}`);
    } else {
      failed += 1;
      lines.push(`#${slot + 1} [${name}] FAILED: ${r.error}`);
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
