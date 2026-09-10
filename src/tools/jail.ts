import * as fs from "node:fs";
import * as path from "node:path";

/**
 * v1 path jail: resolve symlinks and verify the real target stays inside
 * the workspace. Returns the jailed absolute path, or null on escape.
 * Honest scope: harness jail, not OS isolation.
 */
export function jailPath(cwd: string, target: string): string | null {
  const resolved = path.resolve(cwd, target);
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  let realTarget: string;
  try {
    realTarget = fs.existsSync(resolved)
      ? fs.realpathSync(resolved)
      : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  } catch {
    return null;
  }
  const norm = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);
  if (norm(realTarget) !== norm(realCwd) && !norm(realTarget).startsWith(norm(realCwd) + path.sep)) {
    return null;
  }
  return realTarget;
}
