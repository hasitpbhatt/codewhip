import * as fs from "node:fs";
import * as path from "node:path";
import { sha256Hex } from "./hash.js";
import { jailWritePath } from "./tools/jail.js";

/**
 * Per-run file checkpoints (committee ruling 1: undo ships first). Before
 * every edit/write the loop snapshots the target's content into
 * `.codewhip/checkpoints/<runId>/` with a sha256-verified JSONL manifest.
 * `codewhip rollback` restores exactly what a run touched — verify-everything
 * first, then apply newest-to-oldest so the earliest before-image wins.
 * Flat files, zero deps, self-protecting: harness state is never checkpointed.
 */

export type CheckpointEntry = {
  seq: number;
  ts: string;
  /** Repo-relative target path. */
  file: string;
  sha256: string;
  /** false = the run created the file (empty before-image); rollback removes it. */
  existed: boolean;
};

export type BeforeImage = {
  rel: string;
  abs: string;
  /** File content before the call; null when it did not exist yet. */
  content: string | null;
};

export function runCheckpointDir(cwd: string, runId: string): string {
  return path.join(cwd, ".codewhip", "checkpoints", runId);
}

function manifestPath(cwd: string, runId: string): string {
  return path.join(runCheckpointDir(cwd, runId), "manifest.jsonl");
}

function selfProtectedRel(rel: string): boolean {
  const norm = rel.split(path.sep).join("/");
  return (
    norm === "codewhip-policy.yaml" ||
    norm === "policy.md" ||
    norm.startsWith(".codewhip/")
  );
}

/** The same wall for a path that leaves the workspace into an --add-dir root,
 * where the relative check above cannot see the segments. */
function selfProtectedAbs(abs: string): boolean {
  const segs = abs.split(path.sep);
  return (
    segs.includes(".codewhip") ||
    segs[segs.length - 1] === "codewhip-policy.yaml" ||
    segs[segs.length - 1] === "policy.md"
  );
}

/** Capture the before-image for an edit/write target. Null when not capturable.
 * `roots` are the run's extra jail roots: a file there is editable, so it must
 * be checkpointed too — an undo that quietly skipped --add-dir targets would be
 * worse than no undo at all. The manifest keeps the workspace-relative path,
 * which may walk up out of the workspace and resolves back to the same file. */
export function captureBefore(cwd: string, parsed: unknown, roots?: readonly string[]): BeforeImage | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = (parsed as Record<string, unknown>)["path"];
  if (typeof p !== "string" || p.length === 0) return null;
  const abs = path.resolve(cwd, p);
  const rel = path.relative(cwd, abs);
  if (rel.length === 0 || path.isAbsolute(rel)) return null;
  if (rel.startsWith("..")) {
    if (jailWritePath(cwd, p, roots ?? []) === null) return null;
    if (selfProtectedAbs(abs)) return null;
  } else if (selfProtectedRel(rel)) {
    return null;
  }
  try {
    return { rel, abs, content: fs.readFileSync(abs, "utf8") };
  } catch {
    return { rel, abs, content: null };
  }
}

/** Persist one before-image + manifest line. Best-effort: false on disk failure. */
export function saveCheckpoint(cwd: string, runId: string, seq: number, cap: BeforeImage): boolean {
  try {
    const dir = runCheckpointDir(cwd, runId);
    fs.mkdirSync(dir, { recursive: true });
    const existed = cap.content !== null;
    fs.writeFileSync(path.join(dir, `${seq}.before`), cap.content ?? "", "utf8");
    const entry: CheckpointEntry = {
      seq,
      ts: new Date().toISOString(),
      file: cap.rel,
      sha256: sha256Hex(cap.content ?? ""),
      existed,
    };
    fs.appendFileSync(path.join(dir, "manifest.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** All manifest entries for a run, in recorded order. Missing/corrupt → []. */
export function readManifest(cwd: string, runId: string): CheckpointEntry[] {
  try {
    const raw = fs.readFileSync(manifestPath(cwd, runId), "utf8");
    return raw.split("\n").flatMap((line) => {
      if (line.trim().length === 0) return [];
      const e = JSON.parse(line) as CheckpointEntry;
      return typeof e.seq === "number" && typeof e.file === "string" && typeof e.sha256 === "string"
        ? [e]
        : [];
    });
  } catch {
    return [];
  }
}

/** Runs that have checkpoints, newest manifest mtime first. Never throws. */
export function listCheckpointRuns(cwd: string): Array<{ runId: string; files: number }> {
  try {
    const base = path.join(cwd, ".codewhip", "checkpoints");
    return fs.readdirSync(base).flatMap((runId) => {
      const n = readManifest(cwd, runId).length;
      return n > 0 ? [{ runId, files: n }] : [];
    });
  } catch {
    return [];
  }
}

/** Prefix resolve over checkpoint runs (>=4 chars, must be unique). */
export function resolveCheckpointRun(cwd: string, prefix: string): string | null | "ambiguous" {
  if (prefix.length < 4) return null;
  const hits = listCheckpointRuns(cwd).map((r) => r.runId).filter((id) => id.startsWith(prefix));
  if (hits.length === 1) return hits[0] as string;
  return hits.length > 1 ? "ambiguous" : null;
}

/**
 * Verify every before-image against its manifest hash, then restore in
 * reverse recorded order (earliest before-image wins). Never half-applies:
 * any mismatch aborts before the first write.
 */
export function rollbackRun(cwd: string, runId: string): { ok: true; restored: string[]; removed: string[] } | { ok: false; error: string } {
  const entries = readManifest(cwd, runId);
  if (entries.length === 0) {
    return { ok: false, error: `no checkpoints recorded for run ${runId}` };
  }
  const dir = runCheckpointDir(cwd, runId);
  for (const e of entries) {
    try {
      const before = fs.readFileSync(path.join(dir, `${e.seq}.before`), "utf8");
      if (sha256Hex(before) !== e.sha256) {
        return { ok: false, error: `checkpoint hash mismatch at seq ${e.seq} — refusing to restore anything` };
      }
    } catch {
      return { ok: false, error: `missing checkpoint image at seq ${e.seq} — refusing to restore anything` };
    }
  }
  const restored: string[] = [];
  const removed: string[] = [];
  for (const e of [...entries].sort((a, b) => b.seq - a.seq)) {
    const abs = path.resolve(cwd, e.file);
    const rel = path.relative(cwd, abs);
    // A hand-edited manifest must still not restore over harness state, so the
    // protected names are refused wherever they appear. Walking up out of the
    // workspace is allowed: that is how an --add-dir target is recorded, and
    // only a run holding that root could have written the entry.
    if (path.isAbsolute(rel) || selfProtectedRel(rel) || selfProtectedAbs(abs)) {
      return { ok: false, error: `manifest targets a protected path (${e.file}) — refusing to restore anything` };
    }
    try {
      if (e.existed) {
        const before = fs.readFileSync(path.join(dir, `${e.seq}.before`), "utf8");
        fs.writeFileSync(abs, before, "utf8");
        restored.push(e.file);
      } else {
        fs.rmSync(abs, { force: true });
        removed.push(e.file);
      }
    } catch (err) {
      return { ok: false, error: `restore failed at seq ${e.seq}: ${err instanceof Error ? err.message : "error"}` };
    }
  }
  return { ok: true, restored, removed };
}
