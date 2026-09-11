import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";
import { isSecretFileName, jailPath } from "./jail.js";

const MAX_RESULTS = 50;
const MAX_FILES = 2000;
const MAX_SCAN_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 4000;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".codewhip"]);

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(rx, "i");
}

function walk(cwd: string, rel: string, out: string[]): void {
  if (out.length >= MAX_FILES) return;
  const abs = path.join(cwd, rel);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (e.isSymbolicLink()) continue;
    if (e.name.startsWith(".") && e.name !== ".env") {
      if (e.isDirectory() && e.name !== ".codewhip") continue;
    }
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const next = rel === "" ? e.name : rel + "/" + e.name;
    if (e.isDirectory()) {
      walk(cwd, next, out);
    } else if (e.isFile()) {
      // Never crawl secret material (shared list in jail.ts — read/edit
      // refuse it too; push-time redaction is only the second net).
      if (isSecretFileName(e.name)) continue;
      out.push(next);
    }
  }
}

export type SearchArgs = {
  query: string;
  glob?: string;
};

/** Hand-guard (Week-1): static spec + guard instead of zod, zero new deps. */
export function isSearchArgs(x: unknown): x is SearchArgs {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r["query"] === "string" &&
    (r["glob"] === undefined || typeof r["glob"] === "string")
  );
}

/**
 * Search is a synchronous walk (max 2000 files), bounded like this so a
 * pathological model-supplied regex can never burn unbounded CPU on the
 * main thread: per-file size cap, total-bytes budget, and each regex probe
 * sees a capped line. Still sync — a catastrophic-pattern hang on a single
 * 4KB probe is the last remaining unbounded unit, and only a worker thread
 * would fully remove it.
 */
export async function searchTool(
  ctx: ToolContext,
  args: SearchArgs,
  limits?: { maxScanBytes?: number; maxLineChars?: number }
): Promise<ToolResult> {
  if (!args.query || typeof args.query !== "string") {
    return { ok: false, output: "search: missing required arg `query` (string)" };
  }
  if (args.query.length > 500) {
    return { ok: false, output: "search: `query` too long (max 500 chars)" };
  }
  let queryRx: RegExp;
  try {
    queryRx = new RegExp(args.query);
  } catch {
    return { ok: false, output: "search: `query` is not a valid regex" };
  }
  const scanBudget = limits?.maxScanBytes ?? MAX_SCAN_BYTES;
  const lineCap = limits?.maxLineChars ?? MAX_LINE_CHARS;
  const globRx = args.glob ? globToRegExp(args.glob) : null;
  const files: string[] = [];
  walk(ctx.cwd, "", files);
  const hits: string[] = [];
  let scanned = 0;
  let budgetHit = false;
  for (const rel of files) {
    if (hits.length >= MAX_RESULTS) break;
    if (scanned >= scanBudget) {
      budgetHit = true;
      break;
    }
    if (globRx && !globRx.test(rel) && !globRx.test(path.basename(rel))) continue;
    const abs = jailPath(ctx.cwd, rel);
    if (abs === null) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    if (scanned + stat.size > scanBudget) {
      budgetHit = true;
      break;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    scanned += stat.size;
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (queryRx.test(line.slice(0, lineCap))) {
        hits.push(`${rel}:${i + 1}: ${line.slice(0, 300)}`);
        if (hits.length >= MAX_RESULTS) break;
      }
    }
  }
  if (hits.length === 0) {
    return { ok: true, output: "no matches" + (budgetHit ? " — scan budget exhausted, some files skipped" : "") };
  }
  const suffix =
    hits.length >= MAX_RESULTS || budgetHit
      ? `\n… (${hits.length >= MAX_RESULTS ? `first ${hits.length} shown` : "scan budget exhausted, some files skipped"})`
      : "";
  return { ok: true, output: hits.join("\n") + suffix };
}
