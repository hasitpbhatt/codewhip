import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatPort } from "./provider-port.js";
import type { UsageBucket } from "./outcomes.js";
import type { Debug } from "./debug.js";
import type { LoopArgs } from "./loop.js";
import { filtersToolEntirely, parseToolFilterList, type ToolFilter } from "./tool-filter.js";
import { CHILD_TOOL_NAMES, isToolName, type ToolName } from "./tools/types.js";
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
 * Fields: `description` (required), `model`, `max_steps`, `tools` (narrow-only,
 * over a child's read+search), `disallowedTools` (the run-filter grammar).
 * Every other field is refused by name rather than ignored — see REFUSED_FIELDS.
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
  /**
   * `tools:` — the subset of a child's authority this agent is OFFERED. Absent
   * means all of `CHILD_TOOL_NAMES`. The field narrows and never widens: a name
   * outside the child set is a parse error, because advertising `bash` to a
   * read-only child would be a promise the harness breaks on the first call.
   */
  allowed?: readonly ToolName[];
  /** `disallowedTools:` — refusals the child is born with, on top of its parent's. */
  disallowed?: readonly ToolFilter[];
};

/**
 * Claude Code's agent-file fields that codewhip does not honour, each with the
 * reason it cannot be honoured today. They are refused BY NAME — a field that
 * parses and then silently does nothing is a false sentence in a config file,
 * and the author learns it at the worst possible moment. Everything else is
 * refused as "unknown field", so a typo surfaces the same way.
 */
const REFUSED_FIELDS: Readonly<Record<string, string>> = {
  permissionMode: "a child is always plan-mode: read-only, no grants to widen",
  skills: "a child run loads no skills",
  mcpServers: "there is no MCP client, and a child has no network at all",
  hooks: "hooks belong to the run that starts them, not to a roster entry",
  memory: "a child inherits remembered rules from disk; it has no store of its own",
  background: "a child is summoned and awaited — background tasks are the parent's tool",
  effort: "reasoning effort is a per-provider claim this harness cannot verify",
  isolation: "a child shares the parent's jail; there is no worktree handoff",
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
/** Every field this file type understands that is not `description`. */
const KNOWN_OPTIONAL_FIELDS = ["model", "max_steps", "tools", "disallowedTools"] as const;

/**
 * Normalise just the tool TOKEN of each comma-separated entry to lowercase, so
 * a file ported from Claude Code (`disallowedTools: Write, Edit`) meets this
 * repo's lowercase filter grammar. Shapes are left byte-for-byte alone: a path
 * is case-sensitive and a wildcarded one is already refused by the parser.
 */
function lowerToolTokens(value: string): string {
  return value
    .split(",")
    .map((p) => p.replace(/^(\s*)([A-Za-z_]+)/, (_all, lead: string, name: string) => lead + name.toLowerCase()))
    .join(",");
}

/** `tools:` — a comma list of names, narrowed to what a child can actually be given. */
function parseToolsField(fileName: string, raw: string): { allowed: ToolName[] } | { error: string } {
  const seen: ToolName[] = [];
  for (const part of raw.split(",")) {
    const name = part.trim().toLowerCase();
    if (name.length === 0) continue;
    if (!isToolName(name)) {
      return { error: `${fileName}: tools: unknown tool "${name}" — a child is offered only ${CHILD_TOOL_NAMES.join(" / ")}` };
    }
    if (!CHILD_TOOL_NAMES.includes(name)) {
      return {
        error: `${fileName}: tools: "${name}" is not a tool a child can be given — a subagent's whole authority is ${CHILD_TOOL_NAMES.join("+")}, so this field narrows and never widens`,
      };
    }
    if (!seen.includes(name)) seen.push(name);
  }
  if (seen.length === 0) {
    return { error: `${fileName}: tools needs at least one of ${CHILD_TOOL_NAMES.join(", ")}` };
  }
  return { allowed: seen };
}

/**
 * Parse one `.codewhip/agents/<name>.md` source. Flat frontmatter only
 * (`description`, optional `model`, `max_steps`, `tools`, `disallowedTools`);
 * the body is the child system prompt. Any other field is refused by name.
 * Returns null with a reason on any malformed input — callers skip invalid
 * files rather than guess.
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
  for (const key of fields.keys()) {
    if (key === "description") continue;
    if ((KNOWN_OPTIONAL_FIELDS as readonly string[]).includes(key)) continue;
    const why = REFUSED_FIELDS[key];
    if (why !== undefined) return { error: `${fileName}: ${key} is not honoured — ${why}` };
    return { error: `${fileName}: unknown field "${key}" (this file type takes ${["description", ...KNOWN_OPTIONAL_FIELDS].join(", ")})` };
  }
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
  let allowed: readonly ToolName[] | undefined;
  const toolsRaw = fields.get("tools");
  if (toolsRaw !== undefined) {
    const parsed = parseToolsField(fileName, toolsRaw);
    if ("error" in parsed) return parsed;
    allowed = parsed.allowed;
  }
  let disallowed: readonly ToolFilter[] | undefined;
  const disallowedRaw = fields.get("disallowedTools");
  if (disallowedRaw !== undefined) {
    const parsed = parseToolFilterList(lowerToolTokens(disallowedRaw));
    if (parsed.ok === false) return { error: `${fileName}: disallowedTools — ${parsed.error}` };
    disallowed = parsed.filters;
  }
  // A child with no tools is a run that can only apologize, and `tools: read`
  // beside `disallowedTools: read` is a file that contradicts itself. Say so at
  // parse time — the alternative is a delegate call that burns the child's
  // whole budget discovering it.
  const offered = (allowed ?? CHILD_TOOL_NAMES).filter((n) => !filtersToolEntirely(disallowed, n));
  if (offered.length === 0) {
    return { error: `${fileName}: tools and disallowedTools together leave the child with nothing to call` };
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
      ...(allowed === undefined ? {} : { allowed }),
      ...(disallowed === undefined ? {} : { disallowed }),
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

/**
 * The refusals a child is born with: everything its parent was refused, plus
 * the agent file's own `disallowedTools`, plus — when the file narrowed
 * `tools:` — one whole-tool refusal for every child tool it did not name.
 *
 * All three arrive on the SAME path the operator's `--disallowed-tools` flag
 * uses, so there is one mechanism that both un-advertises a spec (toolSpecs)
 * and refuses a call (the ladder above its rungs) — not a frontmatter-specific
 * second one to drift. Inheriting the parent's list is what makes "no --yolo,
 * remembered rule or human yes" true across the delegation boundary rather than
 * accidentally true: today no filter a child could evade is even expressible
 * (read/search take no shape, and a child cannot reach the four shapeful
 * tools), but the day one is, the child must not be the hole.
 */
export function childFiltersFor(agent: AgentDef, parent: readonly ToolFilter[] | undefined): ToolFilter[] {
  const out: ToolFilter[] = [...(parent ?? [])];
  const add = (filter: ToolFilter): void => {
    if (!out.some((x) => x.tool === filter.tool && x.shape === filter.shape)) out.push(filter);
  };
  for (const f of agent.disallowed ?? []) add(f);
  const allowed = agent.allowed;
  if (allowed !== undefined) {
    for (const name of CHILD_TOOL_NAMES) {
      if (!allowed.includes(name)) add({ tool: name, shape: null });
    }
  }
  return out;
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
  /** Parent's `--disallowed-tools` refusals — inherited, because a refusal the
   * operator scoped to the run is not something a subagent can lift. */
  disallowedTools?: readonly ToolFilter[];
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
    // The child's refusals are its parent's refusals plus the agent file's, and
    // that list is what un-advertises `tools:` at the spec level too.
    disallowedTools: childFiltersFor(opts.agent, opts.disallowedTools),
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
