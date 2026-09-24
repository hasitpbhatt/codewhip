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
 * Spelling normalization for the DENY MATCHER only (never for execution):
 * quotes are stripped — both shells splice `g"it"` into `git`, and the
 * matcher must see the command the shell will see — and `.exe`/`.com`
 * suffixes are dropped from tokens so `git.exe`/`cmd.exe` match the same
 * rules as their bare spellings. Substring patterns run on the stripped
 * text too, so a denylisted sequence hidden inside quotes still denies.
 * Safe direction: this can only over-match (e.g. `echo "rm -rf /"` denies),
 * never under-match.
 */
function normalizeForMatching(s: string): string {
  const stripped = normalize(s).replace(/["']/g, "");
  return stripped;
}

function matchTokens(command: string): string[] {
  return normalizeForMatching(command)
    .split(/\s+/)
    .map((t) => t.replace(/\.(exe|com)$/, ""));
}

/**
 * Non-overridable denylist probe, shared by the loop and bash itself.
 * Substring patterns first, then token checks so flag-reordered variants
 * can't dodge ("git push origin --force", "rm -rfv /", "rm --recursive
 * --force /") — the dangerous flags just have to be present. Windows
 * destructors are covered too because bash runs PowerShell on win32.
 */
export function matchDenylist(commandPreview: string): string | null {
  const norm = normalizeForMatching(commandPreview);
  for (const p of DENY_PATTERNS) {
    if (norm.includes(p)) {
      return p;
    }
  }
  const tokens = matchTokens(commandPreview);
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
  const interpDeny = matchInterpreterDeny(tokens);
  if (interpDeny !== null) return interpDeny;
  if (tokens.includes("dd") && tokens.some((t) => t.startsWith("of=/dev/"))) {
    return "dd of=/dev/";
  }
  return null;
}

/**
 * PowerShell script blocks (and, on /bin/sh, brace payloads) are opaque to
 * every string screen — with pipes banned, braces in a SHELL command exist
 * to carry code past it (`start-job { remove-item … }`, find -exec {} …).
 * Bash-only on purpose: tool args are JSON and full of braces. The house
 * method for combining steps is a script file run under an ask-gated
 * interpreter, not inline blocks.
 */
export function matchScriptBlock(command: string): string | null {
  if (/[{}]/.test(command)) {
    return "script block / brace payload is opaque to string screening — write a script file and run it instead";
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
    // flagSet expands single-dash long flags to letters (-force → f,o,r,c,e),
    // so the word check alone missed every real PowerShell spelling — caught
    // by the immunity escape suite with a relative target (absolute paths
    // were denied by worktree containment, masking the hole).
    const force = flags.has("force") || flags.has("f");
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
 * Interpreter indirection: a second program behind the shell. Inline-code
 * flags (`node -e`, `python -c`, `php -r`, `sh -c`) make the payload opaque
 * to string screening — `node -e "require('fs').rmSync('x')"` has no
 * chaining chars, no absolute path, and no denylisted token, yet deletes
 * outside the jail. Nested shells (`powershell`, `pwsh`, `cmd`) are worse:
 * powershell treats bare arguments as -Command, and -EncodedCommand is
 * base64-opaque by design, so the heads are denied outright — there is no
 * legitimate reason to nest a shell inside the tool shell.
 *
 * File/module execution (`node script.js`, `python -m pytest`,
 * `node --version`) stays ask-gated: the target is visible in the string
 * and must first pass through the governed write tool to exist.
 */
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  python: ["c"], python3: ["c"], py: ["c"],
  node: ["e", "eval"], nodejs: ["e", "eval"],
  deno: ["e", "eval"], bun: ["e", "eval"],
  perl: ["e"], ruby: ["e"], php: ["r"],
  lua: ["e"], rscript: ["e"],
  sh: ["c", "command"], bash: ["c", "command"],
  dash: ["c"], zsh: ["c"], fish: ["c", "command"],
};

const NESTED_SHELLS = new Set([
  "powershell",
  "pwsh",
  "cmd",
  // PowerShell-native code executors: the argument IS code, so these are the
  // nested-shell class, not commands — `iex (gc .\b.ps1)` has no chaining
  // chars, no denylisted token, and executes whatever the string contains.
  "iex",
  "invoke-expression",
  "start-job",
  "start-threadjob",
  "invoke-command",
  "add-type",
]);

function matchInterpreterDeny(tokens: string[]): string | null {
  // Encoded payloads defeat every string screen — deny wherever they appear,
  // not just behind a powershell head.
  if (tokens.some((t) => t === "-encodedcommand" || t === "-enc" || t === "-ec" || t === "--eval")) {
    return "encoded/opaque command payload";
  }
  const head = tokens[0] ?? "";
  if (NESTED_SHELLS.has(head)) return `nested shell (${head})`;
  const inline = INLINE_CODE_FLAGS[head];
  if (inline === undefined) return null;
  // Exact short flags (`-e`), letters-only bundles (`perl -ne`, `bash -lc`),
  // and long forms (`--eval`). Deliberately NOT the shared flagSet(): its
  // expansion would misread values like `ruby -Eutf-8` (encoding name,
  // lowercased) as inline `-e`.
  for (const t of tokens.slice(1)) {
    if (t.startsWith("--")) {
      if (inline.includes(t.slice(2).split("=")[0] ?? "")) return `interpreter inline code (${head})`;
    } else if (/^-[a-z]{1,4}$/.test(t)) {
      const letters = t.slice(1);
      if (inline.some((f) => f.length === 1 && letters.includes(f))) return `interpreter inline code (${head})`;
    }
  }
  // `deno eval "..."` is a subcommand, not a flag.
  if (head === "deno" && tokens[1] === "eval") return "interpreter inline code (deno)";
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
  // Dynamic path construction spells paths the static screens never see:
  // $env:TEMP / ${HOME} / %APPDATA% (environment indirection — also an
  // exfil channel), chr(47) / [char]46 / [convert] (computed characters),
  // and quoted-literal concatenation ('.cod'+'ewhip'). The agent works with
  // static worktree-relative paths; computed paths are denied, not asked.
  if (/\$env:|\$env\{|%[a-z_][a-z0-9_]*%|\$\{[a-z_]|chr\s*\(|\[char\]|\[convert\]/i.test(command)) {
    return "dynamic path construction ($env:, %VAR%, ${}, chr()/[char]) escapes string screening — use static worktree-relative paths";
  }
  if (/(['"])[^'"]*\1\s*\+\s*['"]/.test(command)) {
    return "concatenated string literals escape string screening — use static worktree-relative paths";
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
  if (tool === "todo") {
    const a = (parsed as { action?: unknown }).action;
    if (typeof a === "string") return `todo:${a}`;
  }
  return preview;
}

export const POLICY_VERSION = "v1-2026-09-18";
export function checkPermission(
  tool: ToolName,
  commandPreview: string,
  promoted: PromotedDeny[] = [],
  /** Bench-only ablation: when the experiment moves policy CONTENT to the
   * prompt arm, the denylist patterns and promoted denies must not fire
   * harness-side (that is the variable under test). The structural denies
   * (shell chaining, worktree escape) stay — they are the jail, not policy. */
  opts?: { skipPolicyDenies?: boolean }
): PermissionDecision {
  if (opts?.skipPolicyDenies !== true) {
    const denied = matchDenylist(commandPreview);
    if (denied !== null) {
      return {
        decision: "deny",
        ruleId: `denylist:${denied}`,
        reason: `matched non-overridable denylist "${denied}"`,
      };
    }
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
    const block = matchScriptBlock(commandPreview);
    if (block !== null) {
      return {
        decision: "deny",
        ruleId: "denylist:script-block",
        reason: `${block} (bash-only rule: tool args are JSON and full of braces)`,
      };
    }
    // Self-protected paths are harness state and compiled policy: the shell
    // never touches them. `rm -rf .codewhip` would reset the audit chain to
    // genesis and `cp x policy.md` would overwrite compiled denies with one
    // approval — the write/edit tools refuse these paths already; the shell
    // gets the same wall (substring match, substring-safe: also catches
    // ./policy.md, src/../policy.md-style spellings).
    if (/(^|[^\w.])(\.codewhip\b|codewhip-policy\.yaml)(\/|\\|\b|$)|(^|[^\w./\\])policy\.md\b/.test(commandPreview)) {
      return {
        decision: "deny",
        ruleId: "denylist:self-protected",
        reason: "shell commands never touch harness state (.codewhip), codewhip-policy.yaml, or policy.md — use the governed tools",
      };
    }
  }
  // Promoted denies (policy.md, compiled from repeated human declines) beat
  // the allowlist and ask-defaults — refused before any token burns — but
  // never the non-overridable denylist above. Skipped in the bench prompt-arm
  // (policy content moved to the prompt is the variable under test).
  if (opts?.skipPolicyDenies !== true) {
    const hit = matchesPromoted(tool, commandPreview, promoted);
    if (hit !== null) {
      return {
        decision: "deny",
        ruleId: `policy.md:deny:${hit.tool}:${hit.shape}`,
        reason: `promoted deny from policy.md line ${hit.line} ("${hit.tool}:${hit.shape}")`,
      };
    }
  }
  if (tool === "read" || tool === "search") {
    return {
      decision: "allow",
      ruleId: "default:read:allow",
      reason: "read-only tools are allow by default",
    };
  }
  // Delegation grants no authority beyond read/search (children are
  // plan-mode read-only AND have no network — webfetch included — all
  // refused pre-ladder by the harness), so the act of delegating is
  // allow-class and every child call stays individually auditable under
  // the child's runId.
  if (tool === "delegate" || tool === "delegate_many") {
    return {
      decision: "allow",
      ruleId: "delegate:read-only",
      reason: "subagents are read-only (read/search only, no network, no delegation) — delegation grants no extra authority",
    };
  }
  // todo mutates only harness todo state (.codewhip/todos.json) — never a
  // workspace file, never the shell. It lands after promoted-deny matching,
  // so a team can still compile `deny todo:<action>` in policy.md.
  if (tool === "todo") {
    return {
      decision: "allow",
      ruleId: "default:todo:allow",
      reason: "todo mutates only harness todo state (.codewhip/todos.json), never the workspace",
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
  return "defaults read:allow edit:ask write:ask shell:ask webfetch:ask (ask-default; interpreter inline code / nested shells / encoded payloads denied; dynamic paths denied; bash containment is string-based, file tools use realpath jail); run-scoped flags sit outside these verdicts: --disallowed-tools refuses above the ladder, --plan refuses above the ladder, --allowed-tools answers the ask only)";
}
