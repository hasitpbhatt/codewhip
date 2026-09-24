import type { ToolName } from "./tools/types.js";
import { webfetchOrigin } from "./tools/webfetch.js";

/**
 * "Always allow" memory (v2): the user answers `a` at the approval
 * prompt and the command's SHAPE (never the raw command) is stored
 * in .codewhip/remembered.jsonl with provenance {ts, runId, preview_hash}.
 *
 * Shapes are curated, not generic: only a small allowlist of heads
 * may be remembered. Redirects, pipes and other statement separators
 * make a command unmemorable. The model never sees these lines.
 * `find` is deliberately NOT memorable: `-exec` is an executor primitive
 * that would carry arbitrary commands past the chain ban (see
 * docs/moat/torvalds-architecture-review.md).
 */

/** Heads that may be remembered (multi-word heads are exact). */
export const MEMORABLE_MULTI_HEADS: string[] = [
  "git status", "git diff", "git log", "git branch", "git stash",
  "npm test", "npm run", "npx tsx", "npx tsc",
];
/** Single-word heads that may be remembered. */
export const MEMORABLE_SINGLE_HEADS: string[] = [
  "ls", "dir", "cat", "type", "get-content", "head", "tail",
  "where", "pwd", "tree", "echo", "wc",
];

/** Statement separators, redirects, substitutions, AND variable expansions
 * make a command unmemorable. `$VAR` (bare, not just `$()`) is in this
 * class: a remembered `echo *` whose arguments expand attacker-influenced
 * or secret env vars into a remembered-origin query string is an exfil
 * channel the curation list must never store. */
const UNMEMORABLE_RX = /[;&|<>]|`|\$\(|\n|\r|\$[A-Za-z_{]/;

/** True when text carries a statement separator, redirect or expansion.
 * One screen for every grant path: remembered-rule curation and the
 * command-line tool filters must refuse the same inputs. */
export function hasShellSeparators(raw: string): boolean {
  return UNMEMORABLE_RX.test(raw);
}

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
  // Webfetch remembers per https origin ("always allow docs.example.com"),
  // never per URL — query strings can carry tokens and full-URL rules would
  // silently stop matching. Unparseable/non-https subjects stay ask-every-time.
  if (tool === "webfetch") {
    return webfetchOrigin(preview) !== null;
  }
  return true; // edit shapes are exact-path, low risk
}

/** Shape for any memorable tool call; null when refuse-remember. */
export function shapeOf(tool: ToolName, preview: string): string | null {
  if (!isMemorable(tool, preview)) return null;
  if (tool === "bash") return bashShape(preview);
  // Webfetch shapes are bare origins (no tool prefix): the matcher compares
  // the subject URL's origin, so sibling paths share one human yes.
  if (tool === "webfetch") return webfetchOrigin(preview);
  // Edit/write shapes are bare paths (no tool prefix): the matcher compares
  // the subject path directly, and decline keys stay promotable as-is.
  const p = preview.trim().slice(0, 120);
  return p.length > 0 ? p : null;
}

/**
 * Generalizable deny shape for a declined ask — independent of the
 * allow-curation above. Any sane head qualifies (rm/curl/kubectl declines
 * must be promotable too); unmemorable (chained/redirect) commands still
 * yield null because no safe generalization exists. Bash generalizes to the
 * first two tokens (`npm publish *`, `rm -rf *`); edit/write to the path.
 */
export function declineShape(tool: ToolName, subject: string): string | null {
  if (tool === "edit" || tool === "write") {
    const p = subject.trim().slice(0, 120);
    return p.length > 0 ? p : null;
  }
  // Declined webfetch hosts stay promotable as origins (same shape the
  // allow path stores, so allow/deny keys never diverge).
  if (tool === "webfetch") return webfetchOrigin(subject);
  if (tool !== "bash") return null;
  const trimmed = subject.trim();
  if (UNMEMORABLE_RX.test(trimmed)) return null;
  const parts = trimmed.replace(/\s+/g, " ").toLowerCase().split(" ");
  const first = parts[0] ?? "";
  if (first.length === 0 || first.length > 40) return null;
  if (!/^[a-z0-9_./-]+$/.test(first)) return null;
  const second = parts[1];
  if (second !== undefined && second.length > 0 && second.length <= 40 && /^[a-z0-9_./-]+$/.test(second)) {
    return `${first} ${second} *`;
  }
  return `${first} *`;
}

/** Structural check for a STORED shape (load-time re-validation). */
export function isValidStoredShape(tool: string, shape: string): boolean {
  if (tool !== "bash" && tool !== "edit" && tool !== "write" && tool !== "webfetch") return false;
  if (shape.length === 0 || shape.length > 160) return false;
  if (/[\r\n]/.test(shape)) return false;
  if (targetsSelfProtected(shape)) return false;
  // Webfetch shapes are bare https origins only — no paths, no wildcards,
  // no whitespace, so a hand-edited rule can't smuggle a broader grant
  // than the UI offers.
  if (tool === "webfetch") return /^https:\/\/[^/\s]+$/.test(shape);
  if (tool === "bash") {
    if (!shape.endsWith(" *")) return false;
    const head = shape.slice(0, -2);
    return MEMORABLE_MULTI_HEADS.includes(head) || MEMORABLE_SINGLE_HEADS.includes(head);
  }
  return !shape.includes("*");
}

/** Does this shape target a self-protected path? Never remember it. */
export function targetsSelfProtected(shape: string): boolean {
  const segs = shape.toLowerCase().replace(/\\/g, "/").split("/");
  if (segs.includes(".codewhip")) return true;
  const base = segs[segs.length - 1] ?? "";
  return base === "remembered.jsonl" || base === "codewhip-policy.yaml" || base === "policy.md";
}
