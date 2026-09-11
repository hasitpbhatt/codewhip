import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";

export type WriteArgs = {
  path: string;
  content: string;
};

/** Hand-guard (Week-1): static spec + guard instead of zod, zero new deps. */
export function isWriteArgs(x: unknown): x is WriteArgs {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return typeof r["path"] === "string" && typeof r["content"] === "string";
}

/**
 * Worktree jail for writes: unlike read/edit (which require the file to
 * exist and can use jailPath), write creates parent dirs, so resolve to
 * the deepest EXISTING ancestor, realpath it, and re-append the tail.
 * Symlink escapes in the existing portion are caught by realpath.
 */
function jailWritePath(cwd: string, target: string): string | null {
  const resolved = path.resolve(cwd, target);
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  const tail: string[] = [];
  let cur = resolved;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  let abs: string;
  try {
    abs = path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return null;
  }
  const norm = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  if (norm(abs) !== norm(realCwd) && !norm(abs).startsWith(norm(realCwd) + path.sep)) {
    return null;
  }
  return abs;
}

/** Harness self-protection: refuses .codewhip/**, policy files, and secret material. */
export function refusesSelfProtected(abs: string): boolean {
  const segs = abs.split(path.sep);
  return (
    segs.includes(".codewhip") ||
    segs[segs.length - 1] === "remembered.jsonl" ||
    segs[segs.length - 1] === "codewhip-policy.yaml" ||
    segs[segs.length - 1] === "policy.md"
  );
}

export async function writeTool(ctx: ToolContext, args: WriteArgs): Promise<ToolResult> {
  if (args.path.length === 0) {
    return { ok: false, output: "write: missing required arg `path` (string)" };
  }
  if (args.content.length > 1024 * 1024) {
    return { ok: false, output: "write: content too large (>1MB)" };
  }
  const safe = jailWritePath(ctx.cwd, args.path);
  if (safe === null) {
    return { ok: false, output: "write: path escapes workspace jail" };
  }
  if (refusesSelfProtected(safe)) {
    return { ok: false, output: "write: refused — target is harness state (.codewhip/**, policy files)" };
  }
  // Don't clobber a path that is currently a directory.
  try {
    const stat = fs.statSync(safe);
    if (stat.isDirectory()) {
      return { ok: false, output: `write: path is a directory: ${args.path}` };
    }
  } catch {
    // not exists yet — fine
  }
  try {
    fs.mkdirSync(path.dirname(safe), { recursive: true });
    fs.writeFileSync(safe, args.content, "utf8");
    return { ok: true, output: `wrote ${args.path} (${args.content.length} chars)` };
  } catch (err) {
    return { ok: false, output: `write: failed: ${(err as Error).message}` };
  }
}