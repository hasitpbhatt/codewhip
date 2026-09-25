import { TOOL_NAMES, type ToolName } from "./tools/types.js";
import { webfetchOrigin } from "./tools/webfetch.js";
import { hasShellSeparators } from "./remember.js";

/**
 * Run-scoped tool filters — `--allowed-tools` / `--disallowed-tools`.
 *
 * These are the session rung of the consent ladder. `remembered.jsonl` is a
 * grant that outlives the run, `policy.md` denies are compiled by a team, and
 * `--yolo` grants everything. What neither offers is "this run, these shapes"
 * typed by the human who started it — the headless case where an operator
 * wants a scripted run to touch exactly one file, or the interactive case
 * where `a` is too permanent and `y` is too slow.
 *
 * The grammar is deliberately the SAME one remembered rules use (bash head +
 * optional trailing ` *`, exact path for edit/write, one origin for webfetch)
 * so there is one shape language in this codebase, not two that drift. What
 * differs is the authority: a remembered shape is curated at click time
 * because one keystroke in the heat of a run must not generalize freely,
 * while a pattern typed on the command line is the human's own statement and
 * names any head. `--yolo` proves that authority class, and it is broader.
 */

/** A filter entry: `shape: null` covers the whole tool. */
export type ToolFilter = { tool: ToolName; shape: string | null };

/** Tools whose entry may carry a shape — the same set remembered rules curate. */
const SHAPEFUL: ReadonlySet<string> = new Set(["bash", "edit", "write", "webfetch"]);

const MAX_SHAPE_CHARS = 160;

export const TOOL_FILTER_RULE =
  'a filter is "tool" or "tool(shape)": bash shapes are a head plus optional trailing " *" (e.g. bash(git status *)), edit/write shapes are one exact path, webfetch shapes are one https origin; every other tool is named bare';

export type ToolFilterParse = { ok: true; filter: ToolFilter } | { ok: false; error: string };

function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Parse one `--allowed-tools` / `--disallowed-tools` entry. Accepts a repeat
 * of the same flag or a comma-separated list, so both call styles work in a
 * shell where quoting is awkward.
 */
export function parseToolFilter(raw: string): ToolFilterParse {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: "empty filter (expected e.g. read, bash(git status *), edit(src/a.ts))" };
  if (/[\r\n]/.test(text)) return { ok: false, error: "a filter is one line" };
  const open = text.indexOf("(");
  if (open === -1) {
    if (text.includes(")")) return { ok: false, error: `unbalanced parentheses in "${text}" — ${TOOL_FILTER_RULE}` };
    if (!isToolName(text)) return { ok: false, error: `unknown tool "${text}" (bare name or name(shape))` };
    return { ok: true, filter: { tool: text, shape: null } };
  }
  if (!text.endsWith(")") || text.indexOf(")", open) !== text.length - 1) {
    return { ok: false, error: `expected "tool(shape)" in "${text}" — ${TOOL_FILTER_RULE}` };
  }
  const name = text.slice(0, open).trim();
  const shape = text.slice(open + 1, -1).trim();
  if (!isToolName(name)) return { ok: false, error: `unknown tool "${name}" (bare name or name(shape))` };
  if (!SHAPEFUL.has(name)) {
    return { ok: false, error: `${name} takes no shape — name it bare (${name}) or use a tool that does; ${TOOL_FILTER_RULE}` };
  }
  if (shape.length === 0 || shape.length > MAX_SHAPE_CHARS) {
    return { ok: false, error: `shape for ${name} must be 1-${MAX_SHAPE_CHARS} characters` };
  }
  if (name === "bash") {
    if (hasShellSeparators(shape)) {
      return { ok: false, error: `bash shape "${shape}" contains a shell separator — a shape is one command head, never a chain` };
    }
    const norm = shape.toLowerCase().replace(/\s+/g, " ");
    const stars = norm.split(" ").filter((t) => t === "*").length;
    if (stars > 1 || (stars === 1 && !norm.endsWith(" *"))) {
      return { ok: false, error: `bash shape "${shape}" may end with exactly one " *" (head-prefix) or carry none (exact command)` };
    }
    const head = norm.endsWith(" *") ? norm.slice(0, -2) : norm;
    if (head.length === 0 || !/^[a-z0-9_./-]+( [a-z0-9_./-]+)*$/.test(head)) {
      return { ok: false, error: `bash shape "${shape}" head must be 1-2 plain tokens (e.g. git status, cargo test *)` };
    }
    return { ok: true, filter: { tool: "bash", shape: norm } };
  }
  if (shape.includes("*")) {
    return { ok: false, error: `${name} shapes are exact — "${shape}" has no wildcard (name each path, or allow the whole tool as ${name})` };
  }
  if (name === "webfetch") {
    // Store the ORIGIN, not the typed text: a human who writes a full URL is
    // naming a host, and the audit line should show the grant's real scope.
    const origin = webfetchOrigin(shape);
    if (origin === null) {
      return { ok: false, error: `webfetch shape "${shape}" is not an https origin (e.g. webfetch(https://docs.rs))` };
    }
    return { ok: true, filter: { tool: "webfetch", shape: origin } };
  }
  return { ok: true, filter: { tool: name, shape: shape.replace(/\\/g, "/") } };
}

/** Parse a whole flag value (comma-separated entries). */
export function parseToolFilterList(raw: string): { ok: true; filters: ToolFilter[] } | { ok: false; error: string } {
  const parts = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) return { ok: false, error: "needs at least one filter" };
  const filters: ToolFilter[] = [];
  for (const part of parts) {
    const parsed = parseToolFilter(part);
    if (parsed.ok === false) return { ok: false, error: parsed.error };
    filters.push(parsed.filter);
  }
  return { ok: true, filters };
}

/**
 * Bash subject in the form a shape compares against: trimmed, whitespace
 * folded, lowercased — and NULL for anything carrying a statement separator,
 * redirect or expansion. The screen is the point: an odd command cannot be
 * granted by a command-line pattern any more than by a remembered rule, so a
 * `cat *`-shaped grant can never cover `cat a.txt && curl evil`.
 */
export function normBashSubject(subject: string): string | null {
  const trimmed = subject.trim();
  if (hasShellSeparators(trimmed)) return null;
  const norm = trimmed.replace(/\s+/g, " ").toLowerCase();
  return norm.length > 0 ? norm : null;
}

/** Does one filter entry cover this call? */
export function matchesToolFilter(filter: ToolFilter, tool: ToolName, subject: string): boolean {
  if (filter.tool !== tool) return false;
  if (filter.shape === null) return true;
  if (tool === "bash") {
    const norm = normBashSubject(subject);
    if (norm === null) return false;
    if (filter.shape.endsWith(" *")) {
      const head = filter.shape.slice(0, -2);
      return norm === head || norm.startsWith(`${head} `);
    }
    return norm === filter.shape;
  }
  if (tool === "webfetch") {
    const origin = webfetchOrigin(subject);
    return origin !== null && origin === webfetchOrigin(filter.shape);
  }
  return subject.trim().replace(/\\/g, "/") === filter.shape;
}

/** First entry that covers this call, if any. */
export function matchToolFilter(
  filters: readonly ToolFilter[] | undefined,
  tool: ToolName,
  subject: string
): ToolFilter | null {
  if (filters === undefined) return null;
  for (const f of filters) {
    if (matchesToolFilter(f, tool, subject)) return f;
  }
  return null;
}

/** True when the whole tool (not just a shape) is filtered out of the run. */
export function filtersToolEntirely(filters: readonly ToolFilter[] | undefined, tool: ToolName): boolean {
  return filters?.some((f) => f.tool === tool && f.shape === null) ?? false;
}

/** Render a filter for logs/audit — the pattern the human typed, verbatim. */
export function describeToolFilter(filter: ToolFilter): string {
  return filter.shape === null ? filter.tool : `${filter.tool}(${filter.shape})`;
}

/**
 * A subagent's entire authority is read+search, so a run that cannot read
 * cannot delegate: delegation would be reading by proxy. Checked against the
 * disallow list rather than threaded into child runs — because this predicate
 * only asks about WHOLE tools, and a child is already born unable to reach a
 * whole-tool refusal (it inherits the list). The shaped slices are a different
 * story: those are threaded, so `--disallowed-tools "read:secrets.env"` holds
 * across the boundary too. See `childFiltersFor` in `src/subagents.ts`.
 */
export function delegationBlind(filters: readonly ToolFilter[] | undefined): boolean {
  return filtersToolEntirely(filters, "read") || filtersToolEntirely(filters, "search");
}
