import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { configDir } from "./config-dir.js";
import { redactSecrets } from "./redact.js";
import type { ToolName } from "./tools/types.js";

/**
 * Event hooks: user-authored shell commands fired by the harness at run
 * seams, Claude Code's grammar. Three seams can act (`PreToolUse`,
 * `SessionStart`, `UserPromptSubmit`); the other eight observe. The commands
 * run OUTSIDE the bash jail BY DESIGN — this is user config, like
 * a shell profile, not a model request. Containment is structural: hook
 * files live only in configDir()/.codewhip (paths write.ts already refuses
 * to touch), and hooks load ONCE at run start, so a mid-run prompt
 * injection cannot register or edit one. An injected .codewhip/hooks.json
 * would already have to survive the same write-path refusal as a policy.md.
 *
 * Verdicts: exit 2 (or exit-0 stdout {"decision":"deny"}) denies; any other
 * exit-0 passes; timeout/crash/exit-1 WARN and proceed — an infra failure
 * is absence of signal, not an assertion. Payload (redacted) rides stdin.
 *
 * A hook may WITHHOLD a call and never GRANT one. `decision`/`permissionDecision`
 * values other than `deny` are refused out loud, because a hook that outranked
 * the consent ladder would make every `ask` in this harness advisory. The same
 * ruling refuses `updatedInput`: PreToolUse fires after the ladder graded the
 * call, so rewriting its arguments there runs something nobody approved.
 */

export type HookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "SessionEnd"
  | "StopFailure";

export type HookDef = { event: HookEvent; match: string; command: string };
export type LoadedHooks = { defs: HookDef[]; errors: string[] };
export type HookRunResult = {
  status: "pass" | "deny" | "warn";
  reason: string;
  fired: number;
  /** `additionalContext` from every hook that passed — prompt text, and paid as such. */
  context: string;
  /** `systemMessage`: shown to the human who started the run, never sent to a model. */
  systemMessage: string;
  /** Non-null when a hook printed `continue: false` — the reason to stop the run. */
  stop: string | null;
};
export type HookEnvelope = {
  deny: string | null;
  context: string;
  systemMessage: string;
  stop: string | null;
  notes: string[];
};
export type HookPayload = {
  event: HookEvent;
  tool: string;
  seq: number;
  runId: string;
  cwd: string;
  args?: unknown;
  result?: string;
  text?: string;
  error?: string;
};
export type SpawnResult = { code: number; stdout: string; stderr: string; timedOut: boolean };
export type HookDeps = { spawnHook: (command: string, stdin: string, env: Record<string, string>) => Promise<SpawnResult> };

// Record<ToolName, true> forces a compile error if a tool is added and this
// validation mirror forgets it (no runtime import of the registry: loops).
const KNOWN_TOOLS: Record<ToolName, true> = {
  read: true, search: true, edit: true, write: true, bash: true, webfetch: true,
  delegate: true, delegate_many: true, run_in_background: true, task_output: true,
  task_stop: true, todo: true, ask_user: true,
};
const HOOK_EVENTS: readonly HookEvent[] = [
  "PreToolUse", "PostToolUse", "Stop",
  "SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact",
  "SubagentStart", "SubagentStop", "SessionEnd", "StopFailure",
];

/**
 * What a hook is allowed to DO at each seam. One table, so the answer to
 * "can this event stop the run / inject prompt text" is data rather than a
 * branch re-derived at every call site.
 *
 * `stops` is true only where the event fires BEFORE a provider turn and a
 * refusal is therefore still actionable. Everything else describes work that
 * has already happened or is about to happen: a `PostCompact` hook cannot
 * un-compact, and a `SessionEnd` hook has no turn left to stop.
 *
 * `context` is "prompt" only where a model turn genuinely follows. Prompt text
 * re-pays every remaining turn of the run, so injecting it at a seam with no
 * turn after it is prompt text nobody benefits from and the meter charges for.
 */
export type HookPolicy = {
  stops: boolean;
  context: "prompt" | "none";
  /** Why injected `additionalContext` is refused at this seam. */
  contextRefusal: string;
  /**
   * Why a VERDICT (`decision:"deny"` / `exit 2` / `continue:false`) cannot take
   * effect here. Kept separate from `contextRefusal` because they are different
   * rules: a hook author told "additionalContext is refused" learns nothing about
   * why their veto was dropped, which is the one thing they need to know.
   */
  stopRefusal: string;
  /** Whether `match` addresses a tool name; a lifecycle event has no tool. */
  toolScoped: boolean;
  /**
   * True when the event fires whatever `match` says. `Stop` has always been
   * match-agnostic (`event === "Stop" || …` in the original filter), and that
   * is preserved so a config written against it keeps firing. The new
   * lifecycle events deliberately are NOT: they must use `match: "*"`, so a
   * tool name can never masquerade as scoping a run-level seam.
   */
  anyMatch: boolean;
};

const TOOL_SCOPED: HookPolicy = { stops: false, context: "prompt", contextRefusal: "", stopRefusal: "a veto after the call has already run has nothing to stop", toolScoped: true, anyMatch: false };
const RUN_LEVEL: HookPolicy = { stops: false, context: "none", contextRefusal: "the run is over — there is no model turn remaining, so additionalContext is refused rather than dropped in silence", stopRefusal: "the run is already over, so a verdict has nothing left to stop", toolScoped: false, anyMatch: true };
const LIFECYCLE: HookPolicy = { stops: false, context: "none", contextRefusal: "", stopRefusal: "", toolScoped: false, anyMatch: false };

export function hookPolicy(event: HookEvent): HookPolicy {
  switch (event) {
    case "PreToolUse":
      return { stops: true, context: "prompt", contextRefusal: "", stopRefusal: "", toolScoped: true, anyMatch: false };
    case "PostToolUse":
      return TOOL_SCOPED;
    case "SessionStart":
    case "UserPromptSubmit":
      return { stops: true, context: "prompt", contextRefusal: "", stopRefusal: "", toolScoped: false, anyMatch: false };
    // Compaction already ran (or is about to): nothing to inject into, and a
    // veto here would silently undo a transcript the model has to keep.
    case "PreCompact":
    case "PostCompact":
      return { ...LIFECYCLE, contextRefusal: "compaction is the harness's own transcript edit — additionalContext is refused here", stopRefusal: "compaction is the harness's own transcript edit — a verdict cannot veto it" };
    case "SubagentStart":
    case "SubagentStop":
      return { ...LIFECYCLE, contextRefusal: "a subagent's transcript is the parent's to write — additionalContext is refused at both subagent seams", stopRefusal: "this call is already past the PreToolUse hook that gated it — a second verdict here could only contradict the one that approved it" };
    // The run is over: there is no turn left to stop and nothing left to read.
    // `Stop` keeps its match-agnostic dispatch (anyMatch) for backward compat.
    case "Stop":
    case "SessionEnd":
    case "StopFailure":
      return RUN_LEVEL;
  }
}
const MAX_DEFS = 16;
const MAX_COMMAND_CHARS = 2000;
const HOOK_TIMEOUT_MS = 10_000;
const STDOUT_CAP = 65_536;
/** Fields a short-circuited verdict carries nothing of. */
const NO_OUT = { context: "", systemMessage: "", stop: null } as const;
/** `additionalContext` is prompt text, so it is capped like the prompt tail it joins. */
const CONTEXT_CAP = 8_000;
const MESSAGE_CAP = 2_000;

function validDef(item: unknown, file: string, errors: string[]): HookDef | null {
  if (item === null || typeof item !== "object" || Array.isArray(item)) {
    errors.push(`${file}: hook entry is not an object`);
    return null;
  }
  const o = item as Record<string, unknown>;
  const event = o["event"];
  const match = o["match"];
  const command = o["command"];
  if (typeof event !== "string" || !HOOK_EVENTS.includes(event as HookEvent)) {
    errors.push(`${file}: unknown hook event ${JSON.stringify(event) ?? "?"} (want one of ${HOOK_EVENTS.join("|")})`);
    return null;
  }
  const policy = hookPolicy(event as HookEvent);
  // Validation is separate from dispatch. Stop-family events VALIDATE their
  // match strictly ("*" or a known tool — so a typo is still reported), but
  // DISPATCH ignoring the tool (anyMatch) is the legacy behaviour preserved
  // from `event === "Stop" || …`. The genuinely new run-level seams
  // (PreCompact, SubagentStart, …) have no tool at all, so they demand "*".
  const matchOk =
    policy.toolScoped || policy.anyMatch
      ? typeof match === "string" && (match === "*" || match in KNOWN_TOOLS)
      : match === "*";
  if (!matchOk) {
    errors.push(
      policy.toolScoped || policy.anyMatch
        ? `${file}: hook match must be "*" or a tool name, got ${JSON.stringify(match) ?? "?"}`
        : `${file}: ${event} is a lifecycle event with no tool, so its match must be "*" — got ${JSON.stringify(match) ?? "?"}`,
    );
    return null;
  }
  if (typeof command !== "string" || command.length < 1 || command.length > MAX_COMMAND_CHARS) {
    errors.push(`${file}: hook command must be a 1..${MAX_COMMAND_CHARS} char string`);
    return null;
  }
  return { event: event as HookEvent, match: match as string, command };
}

function loadOne(file: string, errors: string[], out: HookDef[]): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return; // missing file = no hooks from here, not an error
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw) as unknown;
  } catch {
    errors.push(`${path.basename(file)}: invalid JSON — this file's hooks skipped`);
    return;
  }
  const arr = Array.isArray(doc)
    ? doc
    : doc !== null && typeof doc === "object" && Array.isArray((doc as { hooks?: unknown }).hooks)
      ? (doc as { hooks: unknown[] }).hooks
      : null;
  if (arr === null) {
    errors.push(`${path.basename(file)}: expected [ … ] or { "hooks": [ … ] }`);
    return;
  }
  for (const item of arr) {
    if (out.length >= MAX_DEFS) {
      errors.push(`${path.basename(file)}: ${MAX_DEFS}-hook cap reached — remaining entries skipped`);
      return;
    }
    const def = validDef(item, path.basename(file), errors);
    if (def !== null) out.push(def);
  }
}

/** User configDir()/hooks.json then project .codewhip/hooks.json, merged. Never throws. */
export function loadHooks(cwd: string): LoadedHooks {
  const defs: HookDef[] = [];
  const errors: string[] = [];
  loadOne(path.join(configDir(), "hooks.json"), errors, defs);
  loadOne(path.join(cwd, ".codewhip", "hooks.json"), errors, defs);
  return { defs, errors };
}

function defaultSpawnHook(command: string, stdin: string, env: Record<string, string>): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const argv = isWin ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(isWin ? "powershell" : "/bin/sh", argv, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...env },
      });
    } catch {
      resolve({ code: -1, stdout: "", stderr: "spawn failed", timedOut: false });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, HOOK_TIMEOUT_MS);
    child.stdout?.on("data", (d: Buffer) => {
      if (stdout.length < STDOUT_CAP) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d: Buffer) => {
      if (stderr.length < STDOUT_CAP) stderr += d.toString("utf8");
    });
    child.stdin?.end(stdin);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: stdout.slice(0, STDOUT_CAP), stderr: `spawn failed: ${err.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout: stdout.slice(0, STDOUT_CAP), stderr: stderr.slice(0, STDOUT_CAP), timedOut });
    });
  });
}

function jsonField(stdout: string, key: string): string | null {
  const t = stdout.trim();
  if (!t.startsWith("{")) return null;
  try {
    const doc = JSON.parse(t) as Record<string, unknown>;
    const v = doc[key];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The JSON a hook may print on stdout, in Claude Code's envelope names.
 *
 * Deliberately asymmetric: every field that would LOOSEN the harness is refused
 * by name with the reason, while an unrecognised key is silence. A hook author
 * who types `permissionDecision: "allow"` must be told that hooks can withhold a
 * call and not grant one — accepting-and-dropping it would read as agreement.
 */
export function parseHookEnvelope(stdout: string): HookEnvelope {
  const env: HookEnvelope = { deny: null, context: "", systemMessage: "", stop: null, notes: [] };
  const t = stdout.trim();
  if (!t.startsWith("{")) return env; // plain stdout is output, not a verdict
  let doc: unknown;
  try {
    doc = JSON.parse(t) as unknown;
  } catch {
    env.notes.push("stdout looked like JSON but did not parse — ignored");
    return env;
  }
  const o = doc as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const decision = str(o["decision"]);
  if (decision !== null) {
    if (decision === "deny") env.deny = str(o["reason"]) ?? "denied by hook";
    else env.notes.push(`decision "${decision}" is not honoured: a hook may deny a call, not grant or re-ask it`);
  }
  if ("continue" in o) {
    if (typeof o["continue"] !== "boolean") env.notes.push("`continue` must be true or false — ignored");
    else if (o["continue"] === false) env.stop = str(o["stopReason"]) ?? "stopped by hook";
  }
  if ("stopReason" in o && env.stop === null) {
    env.notes.push("`stopReason` only means something with `continue: false` — ignored");
  }
  const msg = o["systemMessage"];
  if (msg !== undefined) {
    const m = str(msg);
    if (m === null) env.notes.push("`systemMessage` must be a string — ignored");
    else env.systemMessage = m.slice(0, MESSAGE_CAP);
  }
  const suppress = o["suppressOutput"];
  if (suppress !== undefined) {
    env.notes.push("`suppressOutput` has no effect here: hook stdout is never rendered to the model or the transcript");
  }
  const hso = o["hookSpecificOutput"];
  if (hso !== undefined) {
    if (hso === null || typeof hso !== "object" || Array.isArray(hso)) {
      env.notes.push("`hookSpecificOutput` must be an object — ignored");
      return env;
    }
    const h = hso as Record<string, unknown>;
    const ac = h["additionalContext"];
    if (ac !== undefined) {
      const a = str(ac);
      if (a === null) env.notes.push("`additionalContext` must be a string — ignored");
      else env.context = a.slice(0, CONTEXT_CAP);
    }
    const pd = str(h["permissionDecision"]);
    if (pd !== null) {
      if (pd === "deny") env.deny = str(h["permissionDecisionReason"]) ?? env.deny ?? "denied by hook";
      else env.notes.push(`permissionDecision "${pd}" is not honoured: a hook may deny a call, not grant or re-ask it`);
    }
    if (h["updatedInput"] !== undefined) {
      env.notes.push("`updatedInput` is refused: PreToolUse fires after the ladder graded this call, so rewriting its arguments would run something nobody approved");
    }
  }
  return env;
}

/**
 * Run every hook applicable to (event, tool) sequentially. First explicit
 * deny short-circuits; warnings accumulate but never stop the run. Passing
 * hooks contribute their context and message, and the first `continue: false`
 * names the reason the run should stop.
 */
export async function runHooksFor(
  defs: HookDef[],
  event: HookEvent,
  tool: string,
  payload: HookPayload,
  deps?: HookDeps
): Promise<HookRunResult> {
  const policy = hookPolicy(event);
  const applicable = defs.filter((d) => {
    if (d.event !== event) return false;
    if (policy.anyMatch) return true;
    return policy.toolScoped ? d.match === "*" || d.match === tool : d.match === "*";
  });
  const spawner = deps?.spawnHook ?? defaultSpawnHook;
  const acc = { context: "", systemMessage: "", stop: null as string | null, notes: [] as string[] };
  const join = (a: string, b: string): string => (a.length === 0 ? b : `${a}\n${b}`);
  let fired = 0;
  let warn = "";
  for (const d of applicable) {
    fired += 1;
    const res = await spawner(d.command, JSON.stringify(payload), {
      CODEWHIP_EVENT: event,
      CODEWHIP_TOOL: tool,
      CODEWHIP_RUN_ID: payload.runId,
      CODEWHIP_CWD: payload.cwd,
    });
    if (res.timedOut) {
      warn = `timed out after ${HOOK_TIMEOUT_MS / 1000}s`;
      continue;
    }
    if (res.code === 2) {
      const reason = jsonField(res.stdout, "reason") ?? (res.stderr.trim().slice(0, 500) || "denied by hook");
      // `exit 2` is the documented assertion spelling, so it is the one a hook
      // author is most likely to reach for, and it must behave EXACTLY like
      // `{"decision":"deny"}`. On an observe-only seam neither may report a
      // denial that did not happen — say the veto was dropped, and why. The
      // caller decides what to do with an honoured deny (`status`), so this
      // function keeps its contract: a deny carries NONE of the accumulated
      // context or messages.
      if (policy.stops) return { ...NO_OUT, status: "deny", reason: redactSecrets(reason), fired };
      acc.notes.push(`exit 2 is not honoured at ${event}: ${policy.stopRefusal}`);
      continue;
    }
    if (res.code !== 0) {
      warn = `exited ${res.code} (not an assertion) — proceeding`;
      continue;
    }
    const env = parseHookEnvelope(res.stdout);
    // The policy is enforced HERE, at the seam, not left to the caller's
    // good intentions: a hook that prints a field its event cannot honour is
    // refused by name, exactly like one that tries to grant a permission.
    if (env.deny !== null) {
      // Same contract as `exit 2` above: an honoured deny returns status only
      // (never the accumulated context), and an observe-only seam refuses the
      // veto by name instead of reporting a denial that did not happen.
      if (policy.stops) return { ...NO_OUT, status: "deny", reason: redactSecrets(env.deny), fired };
      acc.notes.push(`"decision":"deny" is not honoured at ${event}: ${policy.stopRefusal}`);
      continue;
    }
    if (env.context.length > 0) {
      if (policy.context === "prompt") acc.context = join(acc.context, env.context).slice(0, CONTEXT_CAP);
      else if (!acc.notes.includes(policy.contextRefusal)) acc.notes.push(policy.contextRefusal);
    }
    if (env.systemMessage.length > 0) acc.systemMessage = join(acc.systemMessage, env.systemMessage).slice(0, MESSAGE_CAP);
    if (env.stop !== null) {
      if (policy.stops && acc.stop === null) acc.stop = env.stop.slice(0, 500);
      else if (!acc.notes.some((n) => n.startsWith("`continue: false`"))) {
        acc.notes.push(`\`continue: false\` is not honoured at ${event} — a hook may withhold a call or a turn, never one that has already been spent`);
      }
    }
    for (const n of env.notes) if (!acc.notes.includes(n)) acc.notes.push(n);
  }
  const notes = acc.notes.join("; ");
  if (notes.length > 0) warn = warn.length > 0 ? `${warn}; ${notes}` : notes;
  return {
    status: warn.length > 0 ? "warn" : "pass",
    reason: redactSecrets(warn).slice(0, 500),
    fired,
    context: redactSecrets(acc.context),
    systemMessage: redactSecrets(acc.systemMessage),
    stop: acc.stop === null ? null : redactSecrets(acc.stop),
  };
}
