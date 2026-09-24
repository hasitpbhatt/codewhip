import type { ToolContext } from "./types.js";
import type { AgentDef, ChildRunResult } from "../subagents.js";
import { runChildAgent } from "../subagents.js";

/** Seed-prompt cap both delegation tools hold children to. */
export const MAX_TASK_CHARS = 8000;

/** A ToolContext once the loop has attached provider state — the precondition
 * both delegation tools check before spawning anything. */
export type LoopContext = ToolContext & {
  port: NonNullable<ToolContext["port"]>;
  model: string;
  label: string;
  depth: number;
};

export function loopContextReady(ctx: ToolContext): ctx is LoopContext {
  return ctx.port !== undefined && typeof ctx.model === "string" && typeof ctx.label === "string" && typeof ctx.depth === "number";
}

/**
 * Assemble a child run from the parent's context so `delegate` and
 * `delegate_many` cannot drift on what a child inherits: same jail, model
 * rotation, retry wait, compact threshold, parent run id for the audit chain,
 * and the parent's event sink when it has one. The per-child deadline is the
 * caller's, because a single child and a fan-out size it differently.
 */
export function runChild(
  ctx: LoopContext,
  child: { agent: AgentDef; task: string; deadlineMs: number; signal?: AbortSignal; tokenBudget?: number }
): Promise<ChildRunResult> {
  return runChildAgent({
    cwd: ctx.cwd,
    agent: child.agent,
    task: child.task,
    port: ctx.port,
    model: ctx.model,
    label: ctx.label,
    depth: ctx.depth,
    signal: child.signal,
    tokenBudget: child.tokenBudget,
    compactTokens: ctx.compactTokens,
    models: ctx.rotationModels,
    retryWait: ctx.retryWait,
    roots: ctx.roots,
    parentRunId: ctx.parentRunId,
    deadlineMs: child.deadlineMs,
    ...(ctx.onChildEvent === undefined ? {} : { onEvent: ctx.onChildEvent }),
  });
}
