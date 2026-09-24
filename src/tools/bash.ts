import { execFile } from "node:child_process";
import type { ToolContext, ToolResult } from "./types.js";
import { commandGuard } from "./shell-guard.js";

export const BASH_TIMEOUT_MS = 30000;
const MAX_OUTPUT_CHARS = 4000;

export type BashArgs = {
  command: string;
  timeoutMs?: number;
};

/** Hand-guard (Week-1): static spec + guard instead of zod, zero new deps. */
export function isBashArgs(x: unknown): x is BashArgs {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r["command"] === "string" &&
    (r["timeoutMs"] === undefined || typeof r["timeoutMs"] === "number")
  );
}

export async function bashTool(
  ctx: ToolContext,
  args: BashArgs,
  signal?: AbortSignal
): Promise<ToolResult> {
  const command = args.command.trim();
  const refused = commandGuard(command);
  if (refused !== null) {
    return { ok: false, output: refused };
  }
  const timeout = args.timeoutMs ?? BASH_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    return { ok: false, output: "bash: `timeoutMs` must be an integer 1000..120000" };
  }
  // Shell-spawn (post Week-1 evidence): raw execFile without a shell made
  // ordinary commands (`touch`, `echo x >> f`, `>` redirection) un-runnable —
  // the model obeyed the old NO-shell prompt and every call failed. The shell
  // runs jailed at ctx.cwd with timeout kill; the denylist still screens the
  // raw command string BEFORE spawn and stays non-overridable.
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWin
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  return new Promise((resolve) => {
    execFile(
      shell,
      shellArgs,
      { cwd: ctx.cwd, timeout, maxBuffer: 512 * 1024, windowsHide: true, signal },
      (err, stdout, stderr) => {
        let combined = stdout;
        if (stderr.length > 0) {
          combined += `\n[stderr]\n${stderr}`;
        }
        if (combined.length > MAX_OUTPUT_CHARS) {
          combined = combined.slice(0, MAX_OUTPUT_CHARS) + `\n… (truncated)`;
        }
        if (err !== null) {
          const code = (err as NodeJS.ErrnoException).code ?? "";
          if (signal !== undefined && signal.aborted) {
            resolve({ ok: false, output: "bash: killed" });
            return;
          }
          if (code === "ETIMEDOUT") {
            resolve({ ok: false, output: `bash: timed out after ${timeout}ms (killed)` });
            return;
          }
          resolve({ ok: false, output: `bash: failed (${code || "error"}): ${combined || "(no output)"}` });
          return;
        }
        resolve({ ok: true, output: combined.length > 0 ? combined : "(no output)" });
      }
    );
  });
}
