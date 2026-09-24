import * as fs from "node:fs";
import * as path from "node:path";

/** Most jail roots one run may carry. Beyond this a "workspace" is a mood. */
export const MAX_ROOTS = 16;

const normCase = (s: string): string => (process.platform === "win32" ? s.toLowerCase() : s);

/** Realpath'd containment: `target` is `root` itself or below it. */
function contained(root: string, target: string): boolean {
  const r = normCase(root);
  const t = normCase(target);
  return t === r || t.startsWith(r + path.sep);
}

/**
 * Ground `--add-dir` / settings roots against the workspace and keep the ones
 * that are real directories. Relative entries resolve against `cwd`; symlinks
 * are followed once, here, so the jail compares real paths. Returns a problem
 * per rejected entry — a root that does not exist is an operator typo, and
 * silently dropping it would advertise authority the run does not have.
 */
export function resolveRoots(raw: readonly string[], cwd: string): { roots: string[]; errors: string[] } {
  const roots: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const abs = path.resolve(cwd, trimmed);
    let real: string;
    try {
      if (!fs.existsSync(abs)) {
        errors.push(`${trimmed}: no such directory`);
        continue;
      }
      real = fs.realpathSync(abs);
      if (!fs.statSync(real).isDirectory()) {
        errors.push(`${trimmed}: not a directory`);
        continue;
      }
    } catch {
      errors.push(`${trimmed}: cannot be resolved`);
      continue;
    }
    try {
      if (contained(fs.realpathSync(cwd), real)) {
        errors.push(`${trimmed}: already inside the workspace`);
        continue;
      }
    } catch {
      /* the workspace itself is checked by jailPath; keep the root */
    }
    const key = normCase(real);
    if (seen.has(key)) continue;
    seen.add(key);
    if (roots.length >= MAX_ROOTS) {
      errors.push(`dropped ${raw.length} entries beyond the ${MAX_ROOTS}-root limit`);
      break;
    }
    roots.push(real);
  }
  return { roots, errors };
}

/**
 * v1 path jail: resolve symlinks and verify the real target stays inside the
 * workspace. Returns the jailed absolute path, or null on escape.
 * Honest scope: harness jail, not OS isolation.
 *
 * `roots` are the operator-declared extra directories (--add-dir, settings
 * `permissions.additionalDirectories`). They widen *containment only*: secret
 * filenames and self-protected harness state are checked against the resolved
 * path by every caller, so an added root buys no new authority over them.
 */
export function jailPath(cwd: string, target: string, roots?: readonly string[]): string | null {
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
  if (!contained(realCwd, realTarget) && !(roots ?? []).some((r) => contained(r, realTarget))) {
    return null;
  }
  return realTarget;
}

/**
 * Worktree jail for writes: unlike read/edit (which require the file to exist
 * and can use jailPath), write creates parent dirs, so resolve to the deepest
 * EXISTING ancestor, realpath it, and re-append the tail. Symlink escapes in
 * the existing portion are caught by realpath.
 */
export function jailWritePath(cwd: string, target: string, roots?: readonly string[]): string | null {
  const resolved = path.resolve(cwd, target);
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    return null;
  }
  const tail: string[] = [];
  let cur = resolved;
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    tail.unshift(path.basename(cur));
    cur = parent;
  }
  let abs: string;
  try {
    abs = path.join(fs.realpathSync(cur), ...tail);
  } catch {
    return null;
  }
  if (!contained(realCwd, abs) && !(roots ?? []).some((r) => contained(r, abs))) {
    return null;
  }
  return abs;
}

/**
 * Secret-material filenames, refused by read/edit and skipped by search.
 * One list, three tools — push-time redaction is only the second net.
 */
const SECRET_FILE_RX = [
  /^\.env(\.|$)/i, /^\.envrc$/i, /\.pem$/i, /\.key$/i, /credentials\.json$/i,
  /^id_(rsa|ed25519|ecdsa)(\.|$)/i, /^\.npmrc$/i, /secrets\.ya?ml$/i,
];

export function isSecretFileName(base: string): boolean {
  return SECRET_FILE_RX.some((rx) => {
    rx.lastIndex = 0;
    return rx.test(base);
  });
}

/** The repo-local private signing key — never served to the model. */
export function isPrivateKeyPath(abs: string): boolean {
  const segs = abs.split(path.sep);
  return segs.includes(".codewhip") && segs[segs.length - 1] === "key";
}
