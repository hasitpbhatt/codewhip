import * as fs from "node:fs";
import * as path from "node:path";
import { jailWritePath } from "./jail.js";
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
  const safe = jailWritePath(ctx.cwd, args.path, ctx.roots);
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