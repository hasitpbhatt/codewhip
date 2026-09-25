import * as fs from "node:fs";
import * as path from "node:path";
import { redactSecrets } from "./redact.js";
import { lockFileOwnerOnly } from "./secure-file.js";

/**
 * `--debug` / `--debug-file`: the harness's own decisions on a channel.
 *
 * The terminal prints what a run DID — every tool call, verdict and hop is
 * already on stderr and on the audit chain. What it does not print is why:
 * which rung of the consent ladder answered, why rotation was skipped, what
 * the transcript weighed when the budget was re-read, what a hook returned.
 * That is exactly the information an operator needs when a run did something
 * surprising, and without it the reasoning dies inside the loop.
 *
 * Three rules, all inherited from the rest of the harness:
 *   - **Redaction is not optional.** A debug log is the widest leak surface in
 *     the program: it sees arguments, subjects and tool output. Every line
 *     passes the same scrubber a transcript push does, at the sink, so no call
 *     site can forget it.
 *   - **Never next to what it describes.** The log may not be an `*.env*` file
 *     and may not land in `.codewhip/`, where it would sit beside the audit
 *     chain, the stored keys and the policy it is busy explaining.
 *   - **A failing sink must not kill a run.** Hitting the size cap or a disk
 *     error writes one warning and goes quiet. Hooks set the precedent: an
 *     infrastructure failure warns and proceeds.
 */

export type Debug = (msg: string) => void;

export const NOOP_DEBUG: Debug = () => {};

/** One line per call site: a stack trace folded into a log is still one line. */
export const MAX_DEBUG_LINE = 2000;
/** 8 MiB, then the sink goes quiet. A log that fills a disk is a new incident. */
export const MAX_DEBUG_BYTES = 8 * 1024 * 1024;

export type DebugOpen = { ok: true; debug: Debug; note: string } | { ok: false; error: string };

/** Why a debug path is refused, or null when it is acceptable. */
export function rejectDebugPath(raw: string): string | null {
  const p = raw.trim();
  if (p.length === 0) return "--debug-file needs a path";
  if (/[\r\n\0]/.test(p)) return "--debug-file may not contain a newline";
  const base = path.basename(p);
  // `*.env*` is the secret-file shape this repo refuses to READ; writing a log
  // over one would be the same act with the polarity flipped.
  if (/\.env/i.test(base)) return `--debug-file may not be an env file ("${base}") — pick another name`;
  const abs = path.resolve(p);
  if (abs.split(path.sep).includes(".codewhip")) {
    return `--debug-file may not land in .codewhip/ (${abs}) — that directory holds the audit chain, keys and policy this log describes`;
  }
  return null;
}

/**
 * Open the sink. `to` is where lines go when no file is named — the caller's
 * prose channel, which is already stderr under `-p` and stdout otherwise, so
 * `-p` keeps its stdout as pure data. `maxBytes` overrides the cap; the CLI
 * never does, but a bounded sink that cannot be bounded smaller is a bound on
 * the caller's disk that only this module's default gets to choose.
 */
export function openDebug(opts: { file?: string; to: (line: string) => void; maxBytes?: number }): DebugOpen {
  const cap = Math.max(1, Math.floor(opts.maxBytes ?? MAX_DEBUG_BYTES));
  const stamp = (): string => new Date().toISOString().slice(11, 23);
  if (opts.file === undefined) {
    return {
      ok: true,
      debug: (msg): void => {
        opts.to(`[dbg ${stamp()}] ${clip(msg)}`);
      },
      note: "debug on (stderr): ladder rungs, retries, budgets, hook outcomes",
    };
  }
  const bad = rejectDebugPath(opts.file);
  if (bad !== null) return { ok: false, error: bad };
  const abs = path.resolve(opts.file);
  try {
    if (!fs.statSync(path.dirname(abs)).isDirectory()) {
      return { ok: false, error: `--debug-file "${abs}": its parent is not a directory` };
    }
  } catch {
    return { ok: false, error: `--debug-file "${abs}": its directory does not exist` };
  }
  let written = 0;
  let locked = false;
  let quiet = false;
  const goQuiet = (why: string): void => {
    if (quiet) return;
    quiet = true;
    opts.to(`[dbg] debug file ${why} — diagnostics stop here, the run continues`);
  };
  const debug: Debug = (msg): void => {
    if (quiet) return;
    const line = `[dbg ${stamp()}] ${clip(msg)}\n`;
    if (written + line.length > cap) {
      goQuiet(`hit the ${cap >= 1024 * 1024 ? `${Math.floor(cap / (1024 * 1024))} MiB` : `${cap} byte`} cap`);
      return;
    }
    written += line.length;
    try {
      // Synchronously, on purpose: a buffered stream can lose the tail of
      // exactly the run that crashed, which is the only run anyone reads.
      fs.appendFileSync(abs, line, { mode: 0o600 });
      if (!locked) {
        locked = true;
        const warn = lockFileOwnerOnly(abs);
        // A failed chmod is a warning, not a reason to lose diagnostics.
        if (warn !== null) opts.to(`[dbg] ${warn}`);
      }
    } catch (e) {
      goQuiet(`write failed (${e instanceof Error ? e.message : "error"})`);
    }
  };
  return { ok: true, debug, note: `debug → ${abs} (appended, secrets redacted, owner-only)` };
}

function clip(msg: string): string {
  const one = msg.replace(/[\r\n]+/g, " ⏎ ");
  const red = redactSecrets(one);
  return red.length > MAX_DEBUG_LINE ? `${red.slice(0, MAX_DEBUG_LINE)}…[clipped]` : red;
}
