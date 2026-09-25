import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatPort } from "./provider-port.js";
import type { UsageBucket } from "./outcomes.js";
import type { Debug } from "./debug.js";
import type { LoopArgs } from "./loop.js";
import { listRules } from "./remember-store.js";
import { parseFlatFrontmatter } from "./frontmatter.js";

/**
 * Declarative subagents: read-only child runs behind the `delegate` tools.
 *
 * Trust model (why this doesn't dilute the harness): children run with
 * plan-mode semantics (edit/write/bash/delegate/webfetch/todo refused pre-ladder
 * — a child has NO network: it sees only the workspace the parent already
 * has), a fresh transcript (no parent history leaks in), and a summary-only
 * return — the child's final text, redacted and capped on the parent's
 * normal tool path. Every child tool call lands on the global hash-chained
 * audit log under the child's own runId, and the child writes its own
 * outcome record (parent_run_id-attributed) — fully auditable, honestly
 * metered (usage folds into the parent's receipt and budget). Delegation
 * grants zero authority beyond read/search, which are allow-class already.
 *
 * Agent files: `.codewhip/agents/<name>.md` — flat frontmatter + prompt body.
 * Name comes from the filename; a file overrides a built-in of the same name.
 */

export const CHILD_DEFAULT_MAX_STEPS = 10;
export const CHILD_MAX_STEPS_CAP = 25;
/** Depth 1: children cannot delegate (the union's hard ceiling for v1). */
export const MAX_DELEGATION_DEPTH = 1;

/** The one delegation predicate — every guard (loop, both tools, this
 * runner) derives from it so the cap can't drift out of sync. */
export function canDelegate(depth: number): boolean {
  return depth + 1 <= MAX_DELEGATION_DEPTH;
}

export type AgentDef = {
  name: string;
  description: string;
  /** Child system prompt (the agent file body, or the built-in text). */
  systemPrompt: string;
  maxSteps: number;
  /** Optional model override — served on the parent's port (same provider). */
  model?: string;
};

const BUILTIN_SOURCES: Array<Omit<AgentDef, "maxSteps"> & { maxSteps?: number }> = [
  {
    name: "explore",
    description: "Investigates code and reports findings with file:line evidence (read-only).",
    systemPrompt:
      "You are the explore subagent: a read-mostly investigator.\n" +
      "Method: search first to locate, then read the specific ranges; verify every claim against real file content.\n" +
      "Report: a compact findings summary — what exists where (file:line), how the pieces connect, and anything surprising. No fixes, no plans, no code changes.",
  },
  {
    name: "review",
    description: "Adversarial code review: correctness bugs, edge cases, security issues (read-only).",
    systemPrompt:
      "You are the review subagent: an adversarial code reviewer.\n" +
      "Method: read the target code fully; hunt for correctness bugs, unhandled edge cases, security issues, and contract violations. Prefer few, real, high-confidence findings over many speculative ones.\n" +
      "Report: numbered findings, each with file:line, severity (P0-P3), and the concrete failure it causes. No fixes.",
  },
  {
    name: "plan",
    description: "Produces an ordered implementation plan grounded in the real code (read-only).",
    systemPrompt:
      "You are the plan subagent: an implementation planner.\n" +
      "Method: read the relevant code until you understand the real constraints; ground every step in the actual files.\n" +
      "Report: an ordered, minimal implementation plan — steps, files touched, risks, and how to verify. No code.",
  },
];

function toDef(src: { name: string; description: string; systemPrompt: string; maxSteps?: number; model?: string }): AgentDef {
  return {
    name: src.name,
    description: src.description,
    systemPrompt: src.systemPrompt,
    maxSteps: src.maxSteps ?? CHILD_DEFAULT_MAX_STEPS,
    ...(src.model === undefined ? {} : { model: src.model }),
  };
}

export const BUILTIN_AGENTS: AgentDef[] = BUILTIN_SOURCES.map(toDef);

const NAME_RX = /^[a-z][a-z0-9_-]{1,31}$/;
/** Agent-file body cap: a runaway system prompt is a cost amplifier the
 * compactor can't touch (system messages are protected from pruning). */
const MAX_BODY_CHARS = 8000;

/**
 * Parse one `.codewhip/agents/<name>.md` source. Flat frontmatter only
 * (`description`, optional `model`, optional `max_steps`); the body is the
 * child system prompt. Returns null with a reason on any malformed input —
 * callers skip invalid files rather than guess.
 */
export function parseAgentFile(fileName: string, raw: string): { agent: AgentDef } | { error: string } {
  const name = fileName.replace(/\.md$/, "");
  if (!NAME_RX.test(name)) {
    return { error: `invalid agent name from filename: ${fileName}` };
  }
  const fm = parseFlatFrontmatter(fileName, raw);
  if ("error" in fm) {
    return fm;
  }
  const { fields, body } = fm;
  const description = fields.get("description") ?? "";
  if (description.length === 0 || description.length > 200) {
    return { error: `${fileName}: description required (1..200 chars)` };
  }
  let maxSteps = CHILD_DEFAULT_MAX_STEPS;
  const stepsRaw = fields.get("max_steps");
  if (stepsRaw !== undefined) {
    const n = Number(stepsRaw);
    if (!Number.isInteger(n) || n < 1 || n > CHILD_MAX_STEPS_CAP) {
      return { error: `${fileName}: max_steps must be an integer 1..${CHILD_MAX_STEPS_CAP}` };
    }
    maxSteps = n;
  }
  const model = fields.get("model");
  if (model !== undefined && model.trim().length === 0) {
    return { error: `${fileName}: model must be a non-empty string` };
  }
  if (body.length === 0) {
    return { error: `${fileName}: empty prompt body` };
  }
  if (body.length > MAX_BODY_CHARS) {
    return { error: `${fileName}: prompt body too long (${body.length} chars, max ${MAX_BODY_CHARS})` };
  }
  return {
    agent: {
      name,
      description,
      systemPrompt: body,
      maxSteps,
      ...(model === undefined ? {} : { model: model.trim() }),
    },
  };
}

/** Built-ins plus `.codewhip/agents/*.md` (files override same-name builtins), name-sorted. */
export function listAgents(cwd: string): AgentDef[] {
  return listAgentsWithErrors(cwd).agents;
}

/** listAgents plus the parse errors it skipped — a typo'd frontmatter must
 * never fail silently (the moment of maximum user investment is a broken
 * agent file, and swallowing it looks like the agent never existed). */
export function listAgentsWithErrors(cwd: string): { agents: AgentDef[]; errors: string[] } {
  const byName = new Map<string, AgentDef>(BUILTIN_AGENTS.map((a) => [a.name, a]));
  const errors: string[] = [];
  const dir = path.join(cwd, ".codewhip", "agents");
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }
  for (const f of files.sort()) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(dir, f), "utf8");
    } catch {
      errors.push(`${f}: unreadable`);
      continue;
    }
    const parsed = parseAgentFile(f, raw);
    if ("agent" in parsed) {
      byName.set(parsed.agent.name, parsed.agent);
    } else {
      errors.push(parsed.error);
    }
  }
  return { agents: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function findAgent(cwd: string, name: string): AgentDef | null {
  return listAgents(cwd).find((a) => a.name === name) ?? null;
}

export type ChildRunOptions = {
  cwd: string;
  agent: AgentDef;
  task: string;
  port: ChatPort;
  /** Parent's model — the child's default when the agent file has no override. */
  model: string;
  label: string;
  depth: number;
  signal?: AbortSignal;
  /** Parent's remaining token budget — enforced live inside the child. */
  tokenBudget?: number;
  /** Parent's compaction ceiling (children share the transcript-size policy). */
  compactTokens?: number;
  /** Same-provider rotation candidates — forwarded only when the child rides
   * the parent's model (a per-agent model override would mis-rotate onto ids
   * from a different family). */
  models?: string[];
  retryWait?: boolean;
  /** Parent's extra jail roots — a child reads the same directories the
   * operator widened the workspace to, never more and never fewer. */
  roots?: readonly string[];
  /** The delegating parent's runId (outcome attribution / metrics de-dup). */
  parentRunId?: string;
  /** Parent's `--debug` sink — a child's decisions join the same log. */
  debug?: Debug;
  /** Progress lines, already prefixed with the agent name. */
  onEvent?: (text: string) => void;
  /** Per-child wall clock — the child's signal aborts when it fires. */
  deadlineMs?: number;
};

export type ChildRunResult =
  | { ok: true; text: string; runId: string; usageByModel: UsageBucket[] }
  | { ok: false; error: string; usageByModel: UsageBucket[] };

/**
 * One read-only child run: fresh transcript, plan-mode refusal ladder,
 * depth+1, remembered rules inherited from disk, parent's signal. Uses a
 * dynamic import for agentLoop (registry → delegate → here → loop) so the
 * static graph stays acyclic — same idiom as the demo's lazy demo.js load.
 */
export async function runChildAgent(opts: ChildRunOptions): Promise<ChildRunResult> {
  if (!canDelegate(opts.depth)) {
    return { ok: false, error: `delegation depth cap is ${MAX_DELEGATION_DEPTH}`, usageByModel: [] };
  }
  const childModel = opts.agent.model ?? opts.model;
  const childArgs: LoopArgs = {
    prompt: opts.task,
    model: childModel,
    label: opts.label,
    cwd: opts.cwd,
    maxSteps: opts.agent.maxSteps,
    yolo: false,
    stdinIsTTY: false,
    port: opts.port,
    signal: opts.signal,
    planMode: true,
    depth: opts.depth + 1,
    remembered: listRules(opts.cwd),
    systemPrompt: opts.agent.systemPrompt,
    ...(opts.debug === undefined ? {} : { debug: opts.debug }),
    ...(opts.parentRunId === undefined ? {} : { parentRunId: opts.parentRunId }),
    ...(opts.roots === undefined ? {} : { roots: opts.roots }),
    ...(opts.tokenBudget === undefined ? {} : { tokenBudget: Math.max(1, opts.tokenBudget) }),
    ...(opts.compactTokens === undefined ? {} : { compactTokens: opts.compactTokens }),
    ...(opts.retryWait === undefined ? {} : { retryWait: opts.retryWait }),
    // Rotation only makes sense on the parent's model family; a per-agent
    // model override rides a different id space — never forward candidates.
    ...(opts.models !== undefined && opts.agent.model === undefined && opts.models.length > 0 ? { models: opts.models } : {}),
    ...(opts.onEvent === undefined
      ? {}
      : { onEvent: (e) => opts.onEvent?.(`[${opts.agent.name}] ${e.text}`) }),
  };
  const { agentLoop } = await import("./loop.js");
  // Per-child deadline: abort the child's OWN signal so the loop settles
  // naturally — its outcome record still writes and its usage still folds
  // (a timed-out child is paid-for work, never an orphan).
  const ctrl = new AbortController();
  const onOuterAbort = (): void => ctrl.abort();
  if (opts.signal?.aborted === true) {
    ctrl.abort();
  } else if (opts.signal !== undefined) {
    opts.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let deadlineFired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.deadlineMs !== undefined) {
    timer = setTimeout(() => {
      deadlineFired = true;
      ctrl.abort();
    }, opts.deadlineMs);
  }
  let r: Awaited<ReturnType<typeof agentLoop>>;
  try {
    r = await agentLoop({ ...childArgs, signal: ctrl.signal });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (opts.signal !== undefined) opts.signal.removeEventListener("abort", onOuterAbort);
  }
  if (deadlineFired) {
    const partial = r.text.length > 0 ? ` — partial: ${r.text.slice(0, 500)}` : "";
    return { ok: false, error: `subagent timed out after ${opts.deadlineMs}ms${partial}`, usageByModel: r.usageByModel };
  }
  if (r.error !== undefined && r.text.length === 0) {
    return { ok: false, error: r.error, usageByModel: r.usageByModel };
  }
  if (r.error !== undefined) {
    return { ok: false, error: `${r.error} — partial: ${r.text}`.trim(), usageByModel: r.usageByModel };
  }
  const text = r.cancelled ? `[subagent cancelled] ${r.text}`.trim() : r.text;
  return { ok: true, text, runId: r.runId, usageByModel: r.usageByModel };
}
