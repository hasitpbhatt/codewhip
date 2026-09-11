import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export type PackInfo = {
  name: string;
  version: number;
  description: string;
};

/** Packs ship with the install (repo `packs/` in dev, `dist/../packs` built). */
export function defaultPacksDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "packs");
}

export function listPacks(packsDir: string): PackInfo[] {
  let names: string[];
  try {
    names = fs.readdirSync(packsDir);
  } catch {
    return [];
  }
  const out: PackInfo[] = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(packsDir, name, "pack.json"), "utf8")) as Partial<PackInfo>;
      out.push({
        name,
        version: typeof meta.version === "number" ? meta.version : 0,
        description: typeof meta.description === "string" ? meta.description : "",
      });
    } catch {
      // Not a pack (no/invalid pack.json) — skip.
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * Pull a pack: copy its policy.md into <cwd>/policy.md. Refuses to
 * overwrite without force. Local-file v1 — no registry, no network
 * (versioned registry + private hosting is the H2 pack registry).
 */
export function pullPack(packsDir: string, cwd: string, name: string, force: boolean): { path: string } | { error: string } {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return { error: `pack: invalid name "${name}" (letters/digits/_/- only)` };
  }
  const src = path.join(packsDir, name, "policy.md");
  try {
    if (fs.statSync(path.join(packsDir, name)).isDirectory() === false) {
      return { error: `pack: "${name}" not found (see: codewhip pack list)` };
    }
  } catch {
    return { error: `pack: "${name}" not found (see: codewhip pack list)` };
  }
  let policy: string;
  try {
    policy = fs.readFileSync(src, "utf8");
  } catch {
    return { error: `pack: "${name}" has no policy.md` };
  }
  const dest = path.join(cwd, "policy.md");
  try {
    if (fs.existsSync(dest) && !force) {
      return { error: "pack: ./policy.md exists — re-run with --force to overwrite" };
    }
    fs.writeFileSync(dest, policy, "utf8");
    return { path: dest };
  } catch {
    return { error: "pack: failed to write ./policy.md (disk write)" };
  }
}