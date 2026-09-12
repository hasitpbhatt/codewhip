import type { ToolContext, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import type { ToolDef } from "./registry.js";
import { findAgent, runChildAgent, MAX_DELEGATION_DEPTH } from "../subagents.js";
import { DELEGATE_TIMEOUT_MS } from "./delegate.js";

/**
 * The `delegate_many` tool: fan one task out to several read-only subagents
 * concurrently (capped) and return their ordered reports — the multi-perspective
 * exploration/convergence case. Results return in entry order regardless of
 * completion order; each child's usage folds into the parent's receipt.
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
  if (ctx.depth + 1 > MAX_DELEGATION_DEPTH) {
    return { ok: false, output: "delegate_many: subagents cannot delegate (depth cap)" };
  }
  const entries = args.entries.slice(0, MAX_FANOUT);
  if (args.entries.length > MAX_FANOUT) {
    return { ok: false, output: `delegate_many: at most ${MAX_FANOUT} entries (got ${args.entries.length})` };
  }
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
        tokenBudget: ctx.remainingBudget,
        compactTokens: ctx.compactTokens,
        models: ctx.rotationModels,
        retryWait: ctx.retryWait,
        parentRunId: ctx.parentRunId,
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
  timeoutMs: DELEGATE_TIMEOUT_MS,
  exec: (ctx, args, signal) =>
    isEntries(args)
      ? runDelegateMany(ctx, args, signal)
      : Promise.resolve({ ok: false, output: `delegate_many: bad args (want entries: 1..${MAX_FANOUT} of {agent, task})` } as ToolResult),
};
