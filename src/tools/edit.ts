import * as fs from "node:fs";
import type { ToolContext, ToolResult } from "./types.js";
import { jailPath } from "./jail.js";

export type EditArgs = {
  path: string;
  oldString: string;
  newString: string;
};

/** Hand-guard (Week-1): static spec + guard instead of zod, zero new deps. */
export function isEditArgs(x: unknown): x is EditArgs {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r["path"] === "string" &&
    typeof r["oldString"] === "string" &&
    typeof r["newString"] === "string"
  );
}

function squash(s: string): string {
  // Strip a trailing CR so CRLF files match LF block comparisons; the file's
  // own line endings are preserved on write (untouched lines keep their \r).
  return s.replace(/\r$/g, "").replace(/[ \t]+/g, " ");
}

function writeEdit(safe: string, display: string, updated: string, strategy: string): ToolResult {
  try {
    fs.writeFileSync(safe, updated, "utf8");
    return { ok: true, output: `edited ${display} (strategy: ${strategy})` };
  } catch (err) {
    return { ok: false, output: `edit: write failed: ${(err as Error).message}` };
  }
}

export async function editTool(ctx: ToolContext, args: EditArgs): Promise<ToolResult> {
  if (args.path.length === 0) {
    return { ok: false, output: "edit: missing required arg `path` (string)" };
  }
  if (args.oldString.length === 0) {
    return { ok: false, output: "edit: `oldString` must not be empty" };
  }
  if (args.oldString.length > 20000 || args.newString.length > 20000) {
    return { ok: false, output: "edit: strings too long (max 20000 chars each)" };
  }
  const safe = jailPath(ctx.cwd, args.path);
  if (safe === null) {
    return { ok: false, output: "edit: path escapes workspace jail" };
  }
  let text: string;
  try {
    const stat = fs.statSync(safe);
    if (!stat.isFile()) {
      return { ok: false, output: `edit: not a file: ${args.path}` };
    }
    if (stat.size > 1024 * 1024) {
      return { ok: false, output: "edit: file too large (>1MB)" };
    }
    text = fs.readFileSync(safe, "utf8");
  } catch {
    return { ok: false, output: `edit: not found: ${args.path} (edit only works on existing files — create new files with write)` };
  }
  // Strategy 1: exact (reproducible under audit replay).
  if (text.includes(args.oldString)) {
    const count = text.split(args.oldString).length - 1;
    if (count !== 1) {
      return { ok: false, output: `edit: oldString matches ${count} times, needs exactly 1` };
    }
    return writeEdit(safe, args.path, text.replace(args.oldString, args.newString), "exact");
  }
  // Strategy 2: whitespace-insensitive block match (file keeps its own whitespace).
  const targetLines = args.oldString.split("\n");
  const lines = text.split("\n");
  const starts: number[] = [];
  for (let i = 0; i + targetLines.length <= lines.length; i++) {
    let match = true;
    for (let j = 0; j < targetLines.length; j++) {
      if (squash(lines[i + j] as string) !== squash(targetLines[j] as string)) {
        match = false;
        break;
      }
    }
    if (match) starts.push(i);
  }
  if (starts.length !== 1) {
    return {
      ok: false,
      output: `edit: no unique match (exact: 0, whitespace-insensitive: ${starts.length})`,
    };
  }
  const at = starts[0] as number;
  const updated = [...lines.slice(0, at), args.newString, ...lines.slice(at + targetLines.length)].join("\n");
  return writeEdit(safe, args.path, updated, "whitespace-insensitive");
}
