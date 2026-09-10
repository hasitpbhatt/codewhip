import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolContext, ToolResult } from "./types.js";

const MAX_RESULTS = 50;
const MAX_FILES = 2000;
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
    if (e.name.startsWith(".") && e.name !== ".env") {
      if (e.isDirectory() && e.name !== ".codewhip") continue;
    }
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
    const next = rel === "" ? e.name : rel + "/" + e.name;
    if (e.isDirectory()) {
      walk(cwd, next, out);
    } else if (e.isFile()) {
      out.push(next);
    }
  }
}

export async function searchTool(
  ctx: ToolContext,
  args: { query: string; glob?: string }
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
  const globRx = args.glob ? globToRegExp(args.glob) : null;
  const files: string[] = [];
  walk(ctx.cwd, "", files);
  const hits: string[] = [];
  for (const rel of files) {
    if (hits.length >= MAX_RESULTS) break;
    if (globRx && !globRx.test(rel) && !globRx.test(path.basename(rel))) continue;
    const abs = path.join(ctx.cwd, rel);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    if (text.includes("\0")) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (queryRx.test(line)) {
        hits.push(`${rel}:${i + 1}: ${line.slice(0, 300)}`);
        if (hits.length >= MAX_RESULTS) break;
      }
    }
  }
  if (hits.length === 0) {
    return { ok: true, output: "no matches" };
  }
  const suffix = hits.length >= MAX_RESULTS ? `\n… (first ${MAX_RESULTS} shown)` : "";
  return { ok: true, output: hits.join("\n") + suffix };
}
