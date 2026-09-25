import * as fs from "node:fs";
import * as path from "node:path";
import { writeOwnerOnlyFile } from "../secure-file.js";
import { redactSecrets } from "../redact.js";
import type { ToolResult } from "./types.js";

/**
 * The store behind the `todo` tool (.codewhip/todos.json): per-item tasks whose
 * blockers are edges that gate claiming, not decoration. This module owns the
 * shape and the graph rules; `src/tools/todo.ts` owns the verbs.
 *
 * Two rulings make a blocker mean something. `blocked` is DERIVED — an item is
 * blocked while any predecessor is not `done` — so the file never carries a
 * second status that can disagree with its own edges. And a blocked item cannot
 * be claimed `in_progress`, which is the only reason to draw an edge.
 */

export type TodoStatus = "pending" | "in_progress" | "done";

export type TodoItem = {
  id: string;
  text: string;
  status: TodoStatus;
  /** What "done" means, for whoever picks this up next. */
  description?: string;
  /** Present-continuous label, shown in place of `text` while in progress. */
  activeForm?: string;
  owner?: string;
  /** Forward and back edges; either direction may be written, both are stored. */
  blocks?: string[];
  blockedBy?: string[];
};

export const MAX_ITEMS = 64;
const MAX_TEXT = 500;
const MAX_DESCRIPTION = 2000;
const MAX_ACTIVE_FORM = 200;
const MAX_OWNER = 64;
const ID_RX = /^[A-Za-z0-9_.-]{1,32}$/;
const STATUSES: readonly string[] = ["pending", "in_progress", "done"];

export type TodoParse = { ok: true; items: TodoItem[] } | { ok: false; error: string };

const bad = (error: string): TodoParse => ({ ok: false, error });

export function todoPath(cwd: string): string {
  return path.join(cwd, ".codewhip", "todos.json");
}

function strField(o: Record<string, unknown>, key: string, max: number, where: string, problems: string[]): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    problems.push(`${where}: "${key}" must be a string of 1..${max} chars`);
    return undefined;
  }
  return v;
}

function idList(o: Record<string, unknown>, key: string, where: string, problems: string[]): string[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) {
    problems.push(`${where}: "${key}" must be an array of ids`);
    return undefined;
  }
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string" || !ID_RX.test(raw)) {
      problems.push(`${where}: "${key}" names "${String(raw)}", which is not an id`);
      continue;
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/** Structural pass, then edges, then the rules that need the whole graph. */
export function sanitizeItems(v: unknown): TodoParse {
  if (!Array.isArray(v)) return bad("items must be an array of {id,text,status}");
  if (v.length > MAX_ITEMS) return bad(`too many items (max ${MAX_ITEMS})`);
  const problems: string[] = [];
  const items: TodoItem[] = [];
  const seen = new Set<string>();
  for (const [n, raw] of v.entries()) {
    const where = `item ${n + 1}`;
    if (typeof raw !== "object" || raw === null) {
      problems.push(`${where}: not an object`);
      continue;
    }
    const o = raw as Record<string, unknown>;
    const id = o["id"];
    if (typeof id !== "string" || !ID_RX.test(id)) {
      problems.push(`${where}: id must match ${ID_RX}`);
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${where}: duplicate id "${id}" (ids must be unique)`);
      continue;
    }
    seen.add(id);
    const text = strField(o, "text", MAX_TEXT, where, problems);
    if (text === undefined && o["text"] === undefined) problems.push(`${where}: "text" is required`);
    const status = o["status"];
    if (typeof status !== "string" || !STATUSES.includes(status)) {
      problems.push(`${where}: status must be pending|in_progress|done`);
      continue;
    }
    const description = strField(o, "description", MAX_DESCRIPTION, where, problems);
    const activeForm = strField(o, "activeForm", MAX_ACTIVE_FORM, where, problems);
    const owner = strField(o, "owner", MAX_OWNER, where, problems);
    const blocks = idList(o, "blocks", where, problems);
    const blockedBy = idList(o, "blockedBy", where, problems);
    if (text === undefined) continue;
    const item: TodoItem = { id, text, status: status as TodoStatus };
    if (description !== undefined) item.description = description;
    if (activeForm !== undefined) item.activeForm = activeForm;
    if (owner !== undefined) item.owner = owner;
    if (blocks !== undefined) item.blocks = blocks;
    if (blockedBy !== undefined) item.blockedBy = blockedBy;
    items.push(item);
  }
  const claimed = items.filter((i) => i.status === "in_progress");
  if (claimed.length > 1) {
    problems.push(`at most one item may be in_progress (${claimed.map((i) => i.id).join(", ")} both claim it)`);
  }
  if (problems.length > 0) return bad(problems.slice(0, 3).join(" — "));

  const unknown = linkEdges(items);
  if (unknown.length > 0) return bad(unknown.slice(0, 3).join(" — "));
  const cycle = findCycle(items);
  if (cycle !== null) return bad(`dependency cycle: ${cycle.join(" → ")} — no order can satisfy it`);
  for (const it of items) {
    if (it.status !== "in_progress") continue;
    const open = blockedOn(items, it);
    if (open.length > 0) return bad(`"${it.id}" is in_progress but blocked by ${open.join(", ")} — finish those first`);
  }
  return { ok: true, items };
}

/**
 * Both directions are stored, whichever one the caller wrote. Returns the
 * edges that name an id the list does not contain — a dangling blocker is
 * refused rather than quietly dropped, because a dropped edge is a grant.
 */
function linkEdges(items: TodoItem[]): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const problems: string[] = [];
  const add = (host: TodoItem, key: "blocks" | "blockedBy", id: string): void => {
    const list = host[key] ?? [];
    if (!list.includes(id)) list.push(id);
    host[key] = list;
  };
  for (const it of items) {
    for (const dep of it.blockedBy ?? []) {
      const target = byId.get(dep);
      if (target === undefined) problems.push(`"${it.id}" is blocked by "${dep}", which is not in the list`);
      else if (target === it) problems.push(`"${it.id}" cannot block itself`);
      else add(target, "blocks", it.id);
    }
    for (const next of it.blocks ?? []) {
      const target = byId.get(next);
      if (target === undefined) problems.push(`"${it.id}" blocks "${next}", which is not in the list`);
      else if (target === it) problems.push(`"${it.id}" cannot block itself`);
      else add(target, "blockedBy", it.id);
    }
  }
  for (const it of items) {
    if (it.blocks !== undefined) it.blocks.sort();
    if (it.blockedBy !== undefined) it.blockedBy.sort();
  }
  return problems;
}

/** Unsatisfied predecessors — an edge whose far end is not `done`. */
export function blockedOn(items: readonly TodoItem[], item: TodoItem): string[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return (item.blockedBy ?? []).filter((id) => byId.get(id)?.status !== "done");
}

export function isBlocked(items: readonly TodoItem[], item: TodoItem): boolean {
  return blockedOn(items, item).length > 0;
}

/** DFS over back edges; returns the cycle path with its head repeated. */
function findCycle(items: readonly TodoItem[]): string[] | null {
  const byId = new Map(items.map((i) => [i.id, i]));
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const walk = (id: string): string[] | null => {
    if (onStack.has(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (seen.has(id)) return null;
    seen.add(id);
    onStack.add(id);
    stack.push(id);
    for (const dep of byId.get(id)?.blockedBy ?? []) {
      const hit = walk(dep);
      if (hit !== null) return hit;
    }
    stack.pop();
    onStack.delete(id);
    return null;
  };
  for (const it of items) {
    const hit = walk(it.id);
    if (hit !== null) return hit;
  }
  return null;
}

/** Fail soft: a corrupt or missing store reads as an empty plan. */
export function loadTodos(cwd: string): TodoItem[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(todoPath(cwd), "utf8")) as unknown;
    const ok = sanitizeItems(parsed);
    return ok.ok ? ok.items : [];
  } catch {
    return [];
  }
}

export function render(items: readonly TodoItem[]): string {
  if (items.length === 0) return "(no todos — replace to set the plan)";
  return items
    .map((i) => {
      const mark = i.status === "done" ? "x" : i.status === "in_progress" ? ">" : " ";
      const label = i.status === "in_progress" && i.activeForm !== undefined ? i.activeForm : i.text;
      const tail: string[] = [];
      const open = blockedOn(items, i);
      if (open.length > 0) tail.push(`blocked by ${open.join(", ")}`);
      if (i.owner !== undefined) tail.push(`@${i.owner}`);
      return `- [${mark}] ${i.id} ${label}${tail.length === 0 ? "" : ` · ${tail.join(" · ")}`}`;
    })
    .join("\n");
}

/** The whole account of one item — what `get` exists for. */
export function detail(items: readonly TodoItem[], item: TodoItem): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const line = (id: string): string => {
    const other = byId.get(id);
    return other === undefined ? id : `${id} (${other.status})`;
  };
  const out = [`- ${item.id} [${item.status}] ${item.text}`];
  if (item.activeForm !== undefined) out.push(`  doing: ${item.activeForm}`);
  if (item.description !== undefined) out.push(`  done means: ${item.description}`);
  if (item.owner !== undefined) out.push(`  owner: ${item.owner}`);
  out.push(`  blocked by: ${(item.blockedBy ?? []).map(line).join(", ") || "nothing — it is ready"}`);
  out.push(`  blocks: ${(item.blocks ?? []).map(line).join(", ") || "nothing"}`);
  if (item.status !== "done" && isBlocked(items, item)) out.push("  ready: no");
  return out.join("\n");
}

/** Owner-only write, secrets redacted at save. A failure is a result, never a throw. */
export function persistTodos(cwd: string, items: readonly TodoItem[]): ToolResult {
  const scrub = (s: string): string => redactSecrets(s);
  const redacted: TodoItem[] = items.map((i) => {
    const out: TodoItem = { id: i.id, text: scrub(i.text), status: i.status };
    if (i.description !== undefined) out.description = scrub(i.description);
    if (i.activeForm !== undefined) out.activeForm = scrub(i.activeForm);
    if (i.owner !== undefined) out.owner = scrub(i.owner);
    if (i.blocks !== undefined) out.blocks = [...i.blocks];
    if (i.blockedBy !== undefined) out.blockedBy = [...i.blockedBy];
    return out;
  });
  try {
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      /* best-effort — POSIX-only bit on shared machines */
    }
    const warning = writeOwnerOnlyFile(todoPath(cwd), JSON.stringify(redacted) + "\n");
    const body = render(redacted);
    return { ok: true, output: warning === null ? body : `${body}\n[todo: permission warning — ${warning}]` };
  } catch {
    return { ok: false, output: "todo: could not write .codewhip/todos.json" };
  }
}
