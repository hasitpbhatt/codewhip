import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { configDir } from "./config-dir.js";
import { redactSecrets } from "./redact.js";
import type { ToolName } from "./tools/types.js";

/**
 * Event hooks: user-authored shell commands fired by the harness at run
 * seams (PreToolUse / PostToolUse / Stop), Claude Code's grammar. The
 * commands run OUTSIDE the bash jail BY DESIGN — this is user config, like
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

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";
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
const HOOK_EVENTS: readonly string[] = ["PreToolUse", "PostToolUse", "Stop"];
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
  if (typeof event !== "string" || !HOOK_EVENTS.includes(event)) {
    errors.push(`${file}: unknown hook event ${JSON.stringify(event) ?? "?"} (want PreToolUse|PostToolUse|Stop)`);
    return null;
  }
  if (typeof match !== "string" || (match !== "*" && !(match in KNOWN_TOOLS))) {
    errors.push(`${file}: hook match must be "*" or a tool name, got ${JSON.stringify(match) ?? "?"}`);
    return null;
  }
  if (typeof command !== "string" || command.length < 1 || command.length > MAX_COMMAND_CHARS) {
    errors.push(`${file}: hook command must be a 1..${MAX_COMMAND_CHARS} char string`);
    return null;
  }
  return { event: event as HookEvent, match, command };
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
  const applicable = defs.filter((d) => d.event === event && (event === "Stop" || d.match === "*" || d.match === tool));
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
      return { ...NO_OUT, status: "deny", reason: redactSecrets(reason), fired };
    }
    if (res.code !== 0) {
      warn = `exited ${res.code} (not an assertion) — proceeding`;
      continue;
    }
    const env = parseHookEnvelope(res.stdout);
    if (env.deny !== null) {
      return { ...NO_OUT, status: "deny", reason: redactSecrets(env.deny), fired };
    }
    if (env.context.length > 0) acc.context = join(acc.context, env.context).slice(0, CONTEXT_CAP);
    if (env.systemMessage.length > 0) acc.systemMessage = join(acc.systemMessage, env.systemMessage).slice(0, MESSAGE_CAP);
    if (env.stop !== null && acc.stop === null) acc.stop = env.stop.slice(0, 500);
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
