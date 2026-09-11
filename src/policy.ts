import type { Permission, ToolName } from "./tools/types.js";
import { matchesPromoted, type PromotedDeny } from "./policy-store.js";

export type PermissionDecision = {
  decision: Permission;
  /** Auditable rule pointer: denylist:<pattern> | policy.md:deny:<tool>:<shape> | allowlist:<prefix> | default:<scope> */
  ruleId: string;
  reason: string;
};

// Non-overridable: checked first, --yolo never bypasses.
const DENY_PATTERNS: string[] = [
  "rm -rf /",
  "rm -rf ~",
  "git push --force",
  "git push -f",
  "--force-with-lease",
  "mkfs",
  ":(){:|:&};:",
];

const SAFE_BASH_PREFIXES: string[] = ["git status", "git diff", "ls", "dir"];

// Shell chaining breaks prefix allowlisting (e.g. `git status; rm -rf /`,
// and on PowerShell/Unix a newline is also a statement separator).
export const CHAIN_RX = /[;&|]|`|\$\(|[\r\n]/;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Non-overridable denylist probe, shared by the loop and bash itself.
 * Substring patterns first, then a token check so a force-push can't dodge
 * ("git push origin --force", "git push origin HEAD -f") by reordering —
 * the flag just has to be present somewhere in a git push.
 */
export function matchDenylist(commandPreview: string): string | null {
  const norm = normalize(commandPreview);
  for (const p of DENY_PATTERNS) {
    if (norm.includes(p)) {
      return p;
    }
  }
  const tokens = norm.split(/\s+/);
  if (
    tokens.includes("git") &&
    tokens.includes("push") &&
    tokens.some((t) => t === "-f" || t === "--force" || t === "--force-with-lease")
  ) {
    return "git push --force";
  }
  return null;
}

/**
 * The string `checkPermission` screens against. For bash this is the
 * FULL command (not the truncated log preview) so denylist/chain patterns
 * past the preview boundary are caught. For everything else the preview
 * is already the right subject.
 */
export function permissionSubject(tool: ToolName, parsed: unknown, preview: string): string {
  if (tool === "bash") {
    const c = (parsed as { command?: unknown }).command;
    if (typeof c === "string") return c;
  }
  if (tool === "edit") {
    const p = (parsed as { path?: unknown }).path;
    if (typeof p === "string") return p;
  }
  if (tool === "write") {
    const p = (parsed as { path?: unknown }).path;
    if (typeof p === "string") return p;
  }
  return preview;
}

export const POLICY_VERSION = "v1-2026-09-10";
export function checkPermission(tool: ToolName, commandPreview: string, promoted: PromotedDeny[] = []): PermissionDecision {
  const denied = matchDenylist(commandPreview);
  if (denied !== null) {
    return {
      decision: "deny",
      ruleId: `denylist:${denied}`,
      reason: `matched non-overridable denylist "${denied}"`,
    };
  }
  // Any shell statement separator (incl. newline/CR, which are statement
  // separators on PowerShell and Unix) bypasses prefix allowlisting, so deny
  // explicitly rather than prompting the user about a mangled command.
  if (tool === "bash" && CHAIN_RX.test(commandPreview)) {
    return {
      decision: "deny",
      ruleId: "denylist:shell-chaining",
      reason: "shell chaining/statement separation is denied (newlines, ;, |, &, `, $())",
    };
  }
  // Promoted denies (policy.md, compiled from repeated human declines) beat
  // the allowlist and ask-defaults — refused before any token burns — but
  // never the non-overridable denylist above.
  const hit = matchesPromoted(tool, commandPreview, promoted);
  if (hit !== null) {
    return {
      decision: "deny",
      ruleId: `policy.md:deny:${hit.tool}:${hit.shape}`,
      reason: `promoted deny from policy.md line ${hit.line} ("${hit.tool}:${hit.shape}")`,
    };
  }
  if (tool === "read" || tool === "search") {
    return {
      decision: "allow",
      ruleId: "default:read:allow",
      reason: "read-only tools are allow by default",
    };
  }
  const norm = normalize(commandPreview);
  if (tool === "bash" && !CHAIN_RX.test(commandPreview)) {
    for (const safe of SAFE_BASH_PREFIXES) {
      if (norm === safe || norm.startsWith(safe + " ")) {
        return {
          decision: "allow",
          ruleId: `allowlist:${safe}`,
          reason: `exact allowlisted prefix "${safe}" with no shell chaining`,
        };
      }
    }
  }
  if (tool === "edit" || tool === "write") {
    return { decision: "ask", ruleId: `default:${tool}:ask`, reason: `${tool} asks by default` };
  }
  return { decision: "ask", ruleId: "default:shell:ask", reason: "shell asks by default" };
}

export function describePolicy(): string {
  return "defaults read:allow edit:ask write:ask shell:ask (ask-default; no external tool scope yet)";
}
