import type { Permission, ToolName } from "./tools/types.js";
import { matchesPromoted, type PromotedDeny } from "./policy-store.js";

export type PermissionDecision = {
  decision: Permission;
  /** Auditable rule pointer: denylist:<pattern> | denylist:worktree-escape | policy.md:deny:<tool>:<shape> | allowlist:<prefix> | default:<scope> */
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
// Redirection (>, <) is in the same class: `git status > policy.md` would
// smuggle a file write past the governed write/edit tools, so it denies too
// (deny lands before ask/remembered — stored `echo *` shapes can't re-allow it).
export const CHAIN_RX = /[;&|<>]|`|\$\(|[\r\n]/;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Non-overridable denylist probe, shared by the loop and bash itself.
 * Substring patterns first, then token checks so flag-reordered variants
 * can't dodge ("git push origin --force", "rm -rfv /", "rm --recursive
 * --force /") — the dangerous flags just have to be present. Windows
 * destructors are covered too because bash runs PowerShell on win32.
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
  const rmDeny = matchRmDeny(tokens);
  if (rmDeny !== null) return rmDeny;
  const winDeny = matchWindowsDeny(tokens);
  if (winDeny !== null) return winDeny;
  if (tokens.includes("dd") && tokens.some((t) => t.startsWith("of=/dev/"))) {
    return "dd of=/dev/";
  }
  return null;
}

/** Expand combined short flags ("-rfv" → r,f,v) for matcher use. */
function flagSet(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (t.startsWith("--")) {
      out.add(t.slice(2).split("=")[0] as string);
    } else if (t.startsWith("-") && t.length > 1 && !t.startsWith("-/")) {
      for (const ch of t.slice(1)) out.add(ch);
    } else if (t.startsWith("/")) {
      out.add(t.slice(1).split(":")[0] as string);
    }
  }
  return out;
}

/**
 * rm is denied only for destructive scope: recursive + force against
 * /, ~, or any absolute target — plus --no-preserve-root anywhere.
 * Plain `rm file` / `rm -r ./build` stay ask-gated as before.
 */
function matchRmDeny(tokens: string[]): string | null {
  if (!tokens.includes("rm")) return null;
  const flags = flagSet(tokens);
  const recursive = flags.has("r") || flags.has("R") || flags.has("recursive");
  const force = flags.has("f") || flags.has("force");
  if (flags.has("no-preserve-root")) return "rm --no-preserve-root";
  if (!recursive || !force) return null;
  const scope = tokens.some(
    (t) =>
      t === "/" || t === "~" || t === "/*" ||
      t.startsWith("~/") || t.startsWith("/*") ||
      /^[a-z]:[\\/]/i.test(t) || t.startsWith("\\\\") || t.startsWith("/") ||
      t === "-rf" || t === "-fr"
  );
  void scope;
  // Recursive+force rm is denied only for wide scope (/, ~, absolute,
  // expanding targets) — relative cleanup like `rm -rf ./build` stays
  // ask-gated. The flag spelling is normalized above, so -rfv-style
  // variants can't dodge.
  const wide = tokens.some(
    (t) =>
      t === "/" || t === "~" || t.startsWith("~/") || t.startsWith("/") ||
      t.startsWith("$") || /^%.*%$/.test(t) ||
      /^[a-z]:[\\/]/i.test(t) || t.startsWith("\\\\")
  );
  return wide ? "rm -rf /" : null;
}

/** PowerShell/cmd destructors (bash runs PowerShell on win32). */
function matchWindowsDeny(tokens: string[]): string | null {  const head = tokens[0] ?? "";
  const flags = flagSet(tokens);
  if (head === "remove-item" || head === "ri" || head === "rmdir") {
    const recurse = flags.has("recurse") || flags.has("r");
    const force = flags.has("force");
    if (recurse && force) return "remove-item -recurse -force";
    return null;
  }
  if (head === "rd") {
    if (flags.has("s")) return "rd /s";
    return null;
  }
  if (head === "del" || head === "erase") {
    if (flags.has("s") && flags.has("f")) return "del /s /f";
    return null;
  }
  if (head === "format") return "format";
  return null;
}

/**
 * Worktree containment for bash (STRING-based, not realpath): parent
 * traversal (`..` segments) and absolute paths (POSIX `/x`, Windows `C:\x`,
 * UNC `\\s\x`, `~/x`) are denied — the agent works inside its worktree via
 * relative paths and PATH-resolved commands. Read/edit/write have the
 * realpath jail; this is the shell equivalent and deliberately strict
 * (even safe absolutes like `/tmp/x` deny — use worktree-relative paths).
 * Version ranges (`1..5`) and `http://` URLs don't match.
 */
export function matchWorktreeEscape(command: string): string | null {
  if (/(^|[/\\\s;"'`(=])\.\.(?=[/\\\s;"'`]|$)/.test(command)) {
    return "parent-directory traversal (..) escapes the worktree";
  }
  if (/(^|[\s;"'`(=])([a-zA-Z]:[\\/]|\\\\|\/(?![a-zA-Z](?:\s|$))|~(?=[/\\]|$))/.test(command)) {
    return "absolute path escapes the worktree";
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
      reason: "shell chaining/statement separation is denied (newlines, ;, |, &, <, >, `, $())",
    };
  }
  // Worktree containment: the shell can't leave the worktree that the file
  // tools are jailed to. Denied (not asked) so --yolo can't wander either.
  if (tool === "bash") {
    const escape = matchWorktreeEscape(commandPreview);
    if (escape !== null) {
      return {
        decision: "deny",
        ruleId: "denylist:worktree-escape",
        reason: `${escape} — use worktree-relative paths and PATH-resolved commands`,
      };
    }
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
  // Webfetch is ask-by-default, never allow-by-default: the network is the
  // exfiltration surface, so each host needs one human yes (memorable via
  // `a`, like shell). The tool itself stays https-only and redacted.
  if (tool === "webfetch") {
    return { decision: "ask", ruleId: "default:webfetch:ask", reason: "webfetch asks by default (one yes per host, memorable)" };
  }
  return { decision: "ask", ruleId: "default:shell:ask", reason: "shell asks by default" };
}

export function describePolicy(): string {
  return "defaults read:allow edit:ask write:ask shell:ask webfetch:ask (ask-default; bash containment is string-based, file tools use realpath jail)";
}
