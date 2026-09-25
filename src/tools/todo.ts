import type { ToolContext, ToolResult } from "./types.js";
import {
  detail,
  isBlocked,
  loadTodos,
  persistTodos,
  render,
  sanitizeItems,
  todoPath,
  type TodoItem,
  type TodoStatus,
} from "./todo-store.js";

/**
 * The `todo` verb layer: list / get / replace / update over the task store in
 * harness state (.codewhip/todos.json). Mutates ONLY that file — never the
 * workspace — which is what earns the `default:todo:allow` policy branch, and
 * why each action is its own subject a team can deny (`deny todo:get`).
 *
 * Every write goes back through `sanitizeItems`, so the rules that make a
 * blocker mean something — one item in progress, no claiming past an open edge
 * — hold for the file on disk, not just for the arguments this call received.
 */

export type { TodoItem, TodoStatus };
export { loadTodos, todoPath };

const ACTIONS: readonly string[] = ["list", "get", "replace", "update"];
const STATUSES: readonly string[] = ["pending", "in_progress", "done"];

export type TodoArgs = {
  action: "list" | "get" | "replace" | "update";
  items?: unknown;
  id?: string;
  status?: unknown;
};

export function isTodoArgs(x: unknown): x is TodoArgs {
  if (typeof x !== "object" || x === null) return false;
  const a = (x as Record<string, unknown>)["action"];
  return typeof a === "string" && ACTIONS.includes(a);
}

const fail = (output: string): ToolResult => ({ ok: false, output });

/** The one gate every write passes: shape, edges, and a claimable status. */
function commit(cwd: string, items: unknown): ToolResult {
  const parsed = sanitizeItems(items);
  return parsed.ok ? persistTodos(cwd, parsed.items) : fail(`todo: ${parsed.error}`);
}

function update(cwd: string, id: unknown, status: unknown): ToolResult {
  if (typeof id !== "string" || id.length === 0) return fail("todo: update needs an id");
  if (typeof status !== "string" || !STATUSES.includes(status)) {
    return fail("todo: status must be pending|in_progress|done");
  }
  const items = loadTodos(cwd);
  if (!items.some((i) => i.id === id)) return fail(`todo: no item "${id}" (list shows current ids)`);
  return commit(cwd, items.map((i) => (i.id === id ? { ...i, status: status as TodoStatus } : i)));
}

function get(cwd: string, id: unknown): ToolResult {
  if (typeof id !== "string" || id.length === 0) return fail("todo: get needs an id");
  const items = loadTodos(cwd);
  const hit = items.find((i) => i.id === id);
  if (hit === undefined) return fail(`todo: no item "${id}" (list shows current ids)`);
  const ready = items.filter((i) => i.status === "pending" && !isBlocked(items, i)).map((i) => i.id);
  return { ok: true, output: `${detail(items, hit)}\nready to claim: ${ready.join(", ") || "nothing"}` };
}

export async function todoTool(ctx: ToolContext, args: TodoArgs): Promise<ToolResult> {
  if (args.action === "list") return { ok: true, output: render(loadTodos(ctx.cwd)) };
  if (args.action === "get") return get(ctx.cwd, args.id);
  if (args.action === "replace") {
    if (!Array.isArray(args.items)) return fail("todo: replace needs items (the full new list of {id,text,status,…})");
    return commit(ctx.cwd, args.items);
  }
  return update(ctx.cwd, args.id, args.status);
}
