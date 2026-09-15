import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/**
 * Owner-only file permissions, cross-platform best-effort.
 *
 * POSIX: chmod 0600 — applied at creation AND as a repair pass, because
 * `writeFileSync(..., { mode })` only sets bits on new files and does
 * nothing to a pre-existing loose file.
 *
 * Windows: Node ignores `mode` entirely, so strip inherited ACLs via icacls
 * and grant the current user only. No output parsing (locale-fragile) —
 * exit status is the whole signal.
 *
 * Returns null when locked down, else a human-readable warning the caller
 * must surface (never swallow: a silent failure re-introduces the exact
 * "0600 file" fiction this module exists to kill).
 */
export function lockFileOwnerOnly(file: string): string | null {
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
      return null;
    } catch {
      return `could not chmod 0600 ${file} — on shared machines prefer env vars over stored keys`;
    }
  }
  try {
    const user = process.env["USERNAME"] ?? process.env["USER"] ?? "";
    if (user.length === 0) {
      return `cannot determine the current user — ${file} may be readable by others; prefer env vars`;
    }
    execFileSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${user}:F`], {
      stdio: "ignore",
      timeout: 10000,
      windowsHide: true,
    });
    return null;
  } catch {
    return `could not restrict ${file} to the current user (icacls failed) — prefer env vars on shared machines`;
  }
}

/**
 * Write a secret-bearing file owner-only: mode 0600 at creation plus the
 * repair/lockdown pass. Returns a warning to surface, or null when clean.
 * Throws on write failure (missing dirs, disk errors) — callers decide.
 */
export function writeOwnerOnlyFile(file: string, data: string | NodeJS.ArrayBufferView): string | null {
  fs.writeFileSync(file, data, { mode: 0o600 });
  return lockFileOwnerOnly(file);
}
