import type { ToolName } from "./tools/types.js";

/**
 * "Always allow" memory (v2): the user answers `a` at the approval
 * prompt and the command's SHAPE (never the raw command) is stored
 * in .codewhip/remembered.jsonl with provenance {ts, runId, preview_hash}.
 *
 * Shapes are curated, not generic: only a small allowlist of heads
 * may be remembered. Redirects, pipes and other statement separators
 * make a command unmemorable. The model never sees these lines.
 */

/** Heads that may be remembered (multi-word heads are exact). */
export const MEMORABLE_MULTI_HEADS: string[] = [
  "git status", "git diff", "git log", "git branch", "git stash",
  "npm test", "npm run", "npx tsx", "npx tsc",
];
/** Single-word heads that may be remembered. */
export const MEMORABLE_SINGLE_HEADS: string[] = [
  "ls", "dir", "cat", "type", "get-content", "head", "tail",
  "find", "where", "pwd", "tree", "echo", "wc",
];

/** Statement separators and redirects make a command unmemorable. */
const UNMEMORABLE_RX = /[;&|]|\$\(|>>?|\n|\r/;

/** Shape is `${head} *`; matching uses startsWith on the head prefix. */
export type Shape = string;

export function bashShape(command: string): string | null {
  const trimmed = command.trim();
  // Screen separators BEFORE collapsing whitespace: a newline/CR embedded in
  // the command is a statement separator on PowerShell and Unix, and would
  // otherwise be eaten by replace(/\s+/g, " ") into a plain space.
  if (UNMEMORABLE_RX.test(trimmed)) return null;
  const norm = trimmed.replace(/\s+/g, " ").toLowerCase();
  const parts = norm.split(" ");
  const first = parts[0] ?? "";
  if (first.length === 0 || first.length > 40) return null;
  if (!/^[a-z0-9_./-]+$/.test(first)) return null;
  if (parts.length >= 2) {
    const multi = `${first} ${parts[1]}`;
    if (MEMORABLE_MULTI_HEADS.includes(multi)) return `${multi} *`;
  }
  if (MEMORABLE_SINGLE_HEADS.includes(first)) return `${first} *`;
  return null;
}

export function isMemorable(tool: ToolName, preview: string): boolean {
  if (tool === "bash") {
    return bashShape(preview) !== null;
  }
  return true; // edit shapes are exact-path, low risk
}

/** Shape for any memorable tool call; null when refuse-remember. */
export function shapeOf(tool: ToolName, preview: string): string | null {
  if (!isMemorable(tool, preview)) return null;
  return tool === "bash" ? bashShape(preview) : `edit:${preview.trim().slice(0, 120)}`;
}

/** Does this shape target a self-protected path? Never remember it. */
export function targetsSelfProtected(shape: string): boolean {
  const n = shape.toLowerCase();
  return n.includes(".codewhip/") || n.includes("remembered.jsonl") || n.includes("codewhip-policy.yaml");
}
