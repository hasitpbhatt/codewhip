import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";

/**
 * The permission ladder, as one declared mode instead of three flags.
 *
 * A mode names where an ASK terminates; nothing here reaches above the
 * ladder. The non-overridable denylist, `--disallowed-tools` and structural
 * denies still refuse first, and a mode can never make a self-protected path
 * writable — it only decides who answers the ask.
 *
 *   default             ask, then prompt the human (the historical behaviour)
 *   acceptEdits         edit/write inside the jail answer themselves; shell and network still ask
 *   plan                read-only run (identical to --plan)
 *   bypassPermissions   the ask answers itself (identical to --yolo; the denylist stands)
 *   dontAsk             no prompt is ever shown: an ungranted ask is refused
 *   manual              nothing pre-authorizes a call: every ask is a prompt,
 *                       including for --allowed-tools, --yolo and remembered rules
 */
export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "manual",
] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function parsePermissionMode(raw: unknown): PermissionMode | null {
  return typeof raw === "string" && (PERMISSION_MODES as readonly string[]).includes(raw)
    ? (raw as PermissionMode)
    : null;
}

export const SETTINGS_FILE = "settings.json";
/** A settings file this big is a mistake, not a config. */
export const MAX_SETTINGS_CHARS = 256_000;

export type Settings = {
  /** Set only when a file declared one; the CLI flag outranks it. */
  defaultMode?: PermissionMode;
  /** Jail roots as written (may be relative — `resolveRoots` grounds them). */
  additionalDirs: string[];
  /** Problems found while reading. A bad key is reported and ignored: a typo
   * must not brick every run, and must not silently change authority either. */
  errors: string[];
  /** Files that were read, lowest precedence first. */
  loaded: string[];
};

type Seed = { mode?: PermissionMode; dirs: string[] };

function mergeFile(file: string, seed: Seed, errors: string[]): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  if (raw.length > MAX_SETTINGS_CHARS) {
    errors.push(`${file}: ${raw.length} chars exceeds ${MAX_SETTINGS_CHARS} — ignored`);
    return true;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    errors.push(`${file}: not valid JSON — ignored`);
    return true;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    errors.push(`${file}: expected a JSON object — ignored`);
    return true;
  }
  const perms = (doc as Record<string, unknown>)["permissions"];
  if (perms === undefined) return true;
  if (typeof perms !== "object" || perms === null || Array.isArray(perms)) {
    errors.push(`${file}: "permissions" is not an object — ignored`);
    return true;
  }
  const p = perms as Record<string, unknown>;
  if (p["defaultMode"] !== undefined) {
    const mode = parsePermissionMode(p["defaultMode"]);
    if (mode === null) {
      errors.push(
        `${file}: permissions.defaultMode ${JSON.stringify(p["defaultMode"])} is not one of ${PERMISSION_MODES.join("|")} — ignored`,
      );
    } else {
      seed.mode = mode;
    }
  }
  const dirs = p["additionalDirectories"];
  if (dirs !== undefined) {
    if (!Array.isArray(dirs)) {
      errors.push(`${file}: permissions.additionalDirectories is not an array — ignored`);
      return true;
    }
    for (const d of dirs) {
      if (typeof d !== "string" || d.length === 0) {
        errors.push(`${file}: skipping empty or non-string additionalDirectories entry`);
        continue;
      }
      seed.dirs.push(d);
    }
  }
  return true;
}

/**
 * Read `permissions` settings: the global `configDir()/settings.json` first,
 * then the project's `.codewhip/settings.json` on top. Either may be absent.
 * Never throws — a malformed file costs one reported line, not the run.
 */
export function loadSettings(cwd: string): Settings {
  const seed: Seed = { dirs: [] };
  const errors: string[] = [];
  const loaded: string[] = [];
  const user = path.join(configDir(), SETTINGS_FILE);
  const project = path.join(cwd, ".codewhip", SETTINGS_FILE);
  if (mergeFile(user, seed, errors)) loaded.push(user);
  if (project !== user && mergeFile(project, seed, errors)) loaded.push(project);
  const seen = new Set<string>();
  return {
    ...(seed.mode === undefined ? {} : { defaultMode: seed.mode }),
    additionalDirs: seed.dirs.filter((d) => (seen.has(d) ? false : (seen.add(d), true))),
    errors,
    loaded,
  };
}
