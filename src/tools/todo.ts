import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { writeOwnerOnlyFile } from "../secure-file.js";
import { redactSecrets } from "../redact.js";

/**
 * Run-scoped task checklist in harness state (.codewhip/todos.json).
 * Mutates ONLY that file — never the workspace — which is what earns the
 * `default:todo:allow` policy branch. Items are validated before write;
 * every failure is an ok:false string, never a throw.
 */

export type TodoStatus = "pending" | "in_progress" | "done";
export type TodoItem = { id: string; text: string; status: TodoStatus };
export type TodoArgs = { action: "list" | "replace" | "update"; items?: unknown; id?: string; status?: unknown };

const MAX_ITEMS = 64;
const MAX_TEXT = 500;
const ID_RX = /^[A-Za-z0-9_.-]{1,32}$/;
const STATUSES: readonly string[] = ["pending", "in_progress", "done"];

export function isTodoArgs(x: unknown): x is TodoArgs {
  if (typeof x !== "object" || x === null) return false;
  const a = (x as Record<string, unknown>)["action"];
  return a === "list" || a === "replace" || a === "update";
}

export function todoPath(cwd: string): string {
  return path.join(cwd, ".codewhip", "todos.json");
}

function isItem(v: unknown): v is TodoItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o["id"] === "string" && ID_RX.test(o["id"]) &&
    typeof o["text"] === "string" && o["text"].length > 0 && o["text"].length <= MAX_TEXT &&
    typeof o["status"] === "string" && STATUSES.includes(o["status"])
  );
}

/** null = invalid/corrupt shape (callers fail soft to empty). */
function sanitizeItems(v: unknown): TodoItem[] | null {
  if (!Array.isArray(v) || v.length > MAX_ITEMS) return null;
  const ids = new Set<string>();
  let inProgress = 0;
  const out: TodoItem[] = [];
  for (const raw of v) {
    if (!isItem(raw)) return null;
    if (ids.has(raw.id)) return null;
    ids.add(raw.id);
    if (raw.status === "in_progress") inProgress += 1;
    out.push({ id: raw.id, text: raw.text, status: raw.status });
  }
  return inProgress > 1 ? null : out;
}

/** Read the store; corrupt or missing content fails soft to empty. */
export function loadTodos(cwd: string): TodoItem[] {
  try {
    const items = sanitizeItems((JSON.parse(fs.readFileSync(todoPath(cwd), "utf8")) as unknown));
    return items ?? [];
  } catch {
    return [];
  }
}

function render(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos — replace to set the plan)";
  return items
    .map((i) => `- [${i.status === "done" ? "x" : i.status === "in_progress" ? ">" : " "}] ${i.id} ${i.text}`)
    .join("\n");
}

function persist(cwd: string, items: TodoItem[]): ToolResult {
  const redacted: TodoItem[] = items.map((i) => ({ ...i, text: redactSecrets(i.text) }));
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

export async function todoTool(_ctx: ToolContext, args: TodoArgs): Promise<ToolResult> {
  if (args.action === "list") {
    return { ok: true, output: render(loadTodos(_ctx.cwd)) };
  }
  if (args.action === "replace") {
    if (!Array.isArray(args.items)) return { ok: false, output: "todo: replace needs items (array of {id,text,status})" };
    const bad =
      args.items.length > MAX_ITEMS
        ? `todo: too many items (max ${MAX_ITEMS})`
        : sanitizeItems(args.items) === null
          ? "todo: items must be {id,text,status} with unique short ids, status pending|in_progress|done, text <= 500 chars, at most one in_progress"
          : null;
    if (bad !== null) return { ok: false, output: bad };
    return persist(_ctx.cwd, sanitizeItems(args.items) as TodoItem[]);
  }
  // update
  const { id } = args;
  const items = loadTodos(_ctx.cwd);
  if (typeof id !== "string" || !ID_RX.test(id)) return { ok: false, output: "todo: update needs a valid id" };
  if (typeof args.status !== "string" || !STATUSES.includes(args.status)) {
    return { ok: false, output: "todo: status must be pending|in_progress|done" };
  }
  const hit = items.find((i) => i.id === id);
  if (hit === undefined) return { ok: false, output: `todo: no item "${id}" (list shows current ids)` };
  hit.status = args.status as TodoStatus;
  return persist(_ctx.cwd, items);
}
