import { execFile } from "node:child_process";
import type { ToolContext, ToolResult } from "./types.js";
import { matchDenylist } from "../policy.js";

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

/** Minimal argv split (quotes respected). No shell is ever spawned. */
function splitArgv(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === " " || ch === "\t") {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export async function bashTool(
  ctx: ToolContext,
  args: BashArgs,
  signal?: AbortSignal
): Promise<ToolResult> {
  const command = args.command.trim();
  if (command.length === 0) {
    return { ok: false, output: "bash: missing required arg `command` (string)" };
  }
  if (command.length > 2000) {
    return { ok: false, output: "bash: `command` too long (max 2000 chars)" };
  }
  const denied = matchDenylist(command);
  if (denied !== null) {
    return { ok: false, output: `bash: denied by denylist:${denied} (non-overridable)` };
  }
  const timeout = args.timeoutMs ?? BASH_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
    return { ok: false, output: "bash: `timeoutMs` must be an integer 1000..120000" };
  }
  const argv = splitArgv(command);
  const file = argv[0];
  if (file === undefined) {
    return { ok: false, output: "bash: missing required arg `command` (string)" };
  }
  return new Promise((resolve) => {
    execFile(
      file,
      argv.slice(1),
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
