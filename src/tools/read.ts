import * as fs from "node:fs";
import type { ToolContext, ToolResult } from "./types.js";
import { jailPath } from "./jail.js";

export async function readTool(
  ctx: ToolContext,
  args: { path: string; offset?: number; limit?: number }
): Promise<ToolResult> {
  if (!args.path || typeof args.path !== "string") {
    return { ok: false, output: "read: missing required arg `path` (string)" };
  }
  const offset = args.offset ?? 1;
  const limit = args.limit ?? 200;
  if (!Number.isInteger(offset) || offset < 1) {
    return { ok: false, output: "read: `offset` must be an integer >= 1" };
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 2000) {
    return { ok: false, output: "read: `limit` must be 1..2000" };
  }
  const safe = jailPath(ctx.cwd, args.path);
  if (safe === null) {
    return { ok: false, output: "read: path escapes workspace jail" };
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(safe);
  } catch {
    return { ok: false, output: `read: not found: ${args.path}` };
  }
  if (!stat.isFile()) {
    return { ok: false, output: `read: not a file: ${args.path}` };
  }
  if (stat.size > 1024 * 1024) {
    return { ok: false, output: "read: file too large (>1MB), use search instead" };
  }
  try {
    const text = fs.readFileSync(safe, "utf8");
    const lines = text.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}: ${l}`);
    const suffix = offset - 1 + limit < lines.length ? `\n… (${lines.length} total lines)` : "";
    return { ok: true, output: numbered.join("\n") + suffix };
  } catch (err) {
    return { ok: false, output: `read: failed: ${(err as Error).message}` };
  }
}
