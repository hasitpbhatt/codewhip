import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatPort } from "./provider-port.js";
import type { UsageBucket } from "./outcomes.js";
import type { LoopArgs } from "./loop.js";
import { listRules } from "./remember-store.js";

/**
 * Declarative subagents: read-only child runs behind the `delegate` tools.
 *
 * Trust model (why this doesn't dilute the harness): children run with
 * plan-mode semantics (edit/write/bash/delegate refused pre-ladder), a fresh
 * transcript (no parent history leaks in), and a summary-only return — the
 * child's final text, redacted and capped on the parent's normal tool path.
 * Every child tool call lands on the global hash-chained audit log under the
 * child's own runId, and the child writes its own outcome record — fully
 * auditable, individually rollback-able, honestly metered (usage folds into
 * the parent's receipt buckets). Delegation grants zero authority beyond
 * read/search/webfetch, which are allow-class already.
 *
 * Agent files: `.codewhip/agents/<name>.md` — flat frontmatter + prompt body.
 * Name comes from the filename; a file overrides a built-in of the same name.
 */

export const CHILD_DEFAULT_MAX_STEPS = 10;
export const CHILD_MAX_STEPS_CAP = 25;
/** Depth 1: children cannot delegate (the union's hard ceiling for v1). */
export const MAX_DELEGATION_DEPTH = 1;

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
  const text = raw.replace(/^\uFEFF/, "");
  if (!text.startsWith("---")) {
    return { error: `${fileName}: missing frontmatter (start with ---)` };
  }
  const end = text.indexOf("\n---", 3);
  if (end === -1) {
    return { error: `${fileName}: frontmatter not closed (--- ... ---)` };
  }
  const header = text.slice(3, end).split("\n");
  const body = text.slice(end + 4).trim();
  const fields = new Map<string, string>();
  for (const line of header) {
    const t = line.trim();
    if (t.length === 0 || t.startsWith("#")) continue;
    const m = /^([a-z_]+)\s*:\s*(.+?)\s*$/.exec(t);
    if (m === null) return { error: `${fileName}: malformed frontmatter line "${t.slice(0, 40)}"` };
    fields.set(m[1] as string, m[2] as string);
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
  if (model !== undefined && model.length === 0) {
    return { error: `${fileName}: model must be a non-empty string` };
  }
  if (body.length === 0) {
    return { error: `${fileName}: empty prompt body` };
  }
  return {
    agent: {
      name,
      description,
      systemPrompt: body,
      maxSteps,
      ...(model === undefined ? {} : { model }),
    },
  };
}

/** Built-ins plus `.codewhip/agents/*.md` (files override same-name builtins), name-sorted. */
export function listAgents(cwd: string): AgentDef[] {
  const byName = new Map<string, AgentDef>(BUILTIN_AGENTS.map((a) => [a.name, a]));
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
      continue;
    }
    const parsed = parseAgentFile(f, raw);
    if ("agent" in parsed) {
      byName.set(parsed.agent.name, parsed.agent);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
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
  /** Progress lines, already prefixed with the agent name. */
  onEvent?: (text: string) => void;
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
  if (opts.depth + 1 > MAX_DELEGATION_DEPTH) {
    return { ok: false, error: `delegation depth cap is ${MAX_DELEGATION_DEPTH}`, usageByModel: [] };
  }
  const childArgs: LoopArgs = {
    prompt: opts.task,
    model: opts.agent.model ?? opts.model,
    label: opts.label as LoopArgs["label"],
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
    ...(opts.onEvent === undefined
      ? {}
      : { onEvent: (e) => opts.onEvent?.(`[${opts.agent.name}] ${e.text}`) }),
  };
  const { agentLoop } = await import("./loop.js");
  const r = await agentLoop(childArgs);
  if (r.error !== undefined && r.text.length === 0) {
    return { ok: false, error: r.error, usageByModel: r.usageByModel };
  }
  if (r.error !== undefined) {
    return { ok: false, error: `${r.error} — partial: ${r.text}`.trim(), usageByModel: r.usageByModel };
  }
  const text = r.cancelled ? `[subagent cancelled] ${r.text}`.trim() : r.text;
  return { ok: true, text, runId: r.runId, usageByModel: r.usageByModel };
}
