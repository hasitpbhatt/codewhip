import * as fs from "node:fs";
import * as path from "node:path";
import { isSecretFileName } from "./jail.js";

export const MAX_RESULTS = 50;
const MAX_FILES = 2000;
export const MAX_SCAN_BYTES = 8 * 1024 * 1024;
export const MAX_LINE_CHARS = 4000;
// Build-output and dependency trees eat the 2,000-file budget before real
// source. Making this policy-configurable would extend the frozen
// codewhip-policy.yaml schema (needs a recorded ruling per
// docs/moat/00-convergence.md) — until then these are built-in, and a repo
// with an unusual layout can search specific globs to work around gaps.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  ".codewhip",
  "target",
  "vendor",
  "__pycache__",
  "build",
]);

export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const rx = "^" + escaped.replace(/\*/g, ".*").replace(/\?/g, ".") + "$";
  return new RegExp(rx, "i");
}

export function walk(cwd: string, rel: string, out: string[]): void {
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
