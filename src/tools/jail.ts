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
