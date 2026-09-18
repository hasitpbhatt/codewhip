import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { readManifest } from "./checkpoints.js";
import { sha256Hex } from "./hash.js";

/**
 * Verdict signal (P1): human judgment attached to a run AFTER it finishes.
 * Stored in `.codewhip/verdicts.jsonl` (one JSON object per line, latest
 * wins per runId) so `outcomes.jsonl` v1 stays frozen and append-only —
 * no in-place rewrite, old readers unaffected.
 *
 * Values:
 * - accepted: output used as-is, tests pass, no rescue.
 * - edited: useful but needed human edits.
 * - reverted: output reverted / not used.
 * - rejected: run failed / wrong direction.
 */

export const VERDICTS = ["accepted", "edited", "reverted", "rejected"] as const;
export type Verdict = (typeof VERDICTS)[number];

export function isVerdict(x: unknown): x is Verdict {
  return typeof x === "string" && (VERDICTS as readonly string[]).includes(x);
}

export type VerdictRecord = {
  v: 1;
  ts: string;
  runId: string;
  verdict: Verdict;
};

export function verdictsPath(cwd: string): string {
  return path.join(cwd, ".codewhip", "verdicts.jsonl");
}

/** Append a verdict. Latest per runId wins. Never throws. */
export function setVerdict(cwd: string, runId: string, verdict: Verdict): boolean {
  try {
    if (runId.length === 0) return false;
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    const rec: VerdictRecord = { v: 1, ts: new Date().toISOString(), runId, verdict };
    fs.appendFileSync(verdictsPath(cwd), JSON.stringify(rec) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Latest verdict per runId, skipping malformed lines. */
export function readVerdictMap(cwd: string): Map<string, VerdictRecord> {
  const out = new Map<string, VerdictRecord>();
  try {
    const raw = fs.readFileSync(verdictsPath(cwd), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const r = JSON.parse(line) as VerdictRecord;
        if (r.v !== 1 || typeof r.runId !== "string" || !isVerdict(r.verdict)) continue;
        out.set(r.runId, r);
      } catch { /* skip malformed */ }
    }
  } catch { /* missing file = no verdicts */ }
  return out;
}

/** Prefix resolve over outcomes+verdicts. Empty when no match. */
export function resolveRunPrefix(cwd: string, prefix: string): string[] {
  if (prefix.length < 4) return [];
  const hits: string[] = [];
  try {
    const raw = fs.readFileSync(path.join(cwd, ".codewhip", "outcomes.jsonl"), "utf8");
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const r = JSON.parse(line) as { runId?: unknown };
        if (typeof r.runId === "string" && r.runId.startsWith(prefix) && !hits.includes(r.runId)) {
          hits.push(r.runId);
        }
      } catch { /* skip */ }
    }
  } catch { /* no outcomes */ }
  for (const id of readVerdictMap(cwd).keys()) {
    if (id.startsWith(prefix) && !hits.includes(id)) hits.push(id);
  }
  return hits;
}

export type AutoProposal = {
  verdict: Verdict;
  confidence: "high" | "low";
  evidence: string[];
};

/**
 * Mechanical verdict proposal for a finished run. Compares the run's
 * checkpoint manifest against the tree as it stands now: a file equal to its
 * before-image means the run's edit did not survive (rolled back or reverted);
 * a file still differing means the edit is live. Git status, when available,
 * catches tree changes the manifest cannot explain (bash-side mutations) and
 * drops confidence accordingly. This only PROPOSES — the human confirms in
 * `codewhip verdict --auto` — because "accepted" mechanically means "edits
 * survived", not "tests passed".
 */
export function proposeVerdict(cwd: string, runId: string): AutoProposal | { error: string } {
  const entries = readManifest(cwd, runId);
  if (entries.length === 0) {
    return { error: "no checkpoints for this run (nothing was edited/written) — judge manually" };
  }
  let live = 0;
  let undone = 0;
  const evidence: string[] = [];
  const manifestFiles = new Set<string>();
  for (const e of entries) {
    manifestFiles.add(e.file.split("\\").join("/"));
    const abs = path.resolve(cwd, e.file);
    let current: string | null = null;
    try {
      current = fs.readFileSync(abs, "utf8");
    } catch {
      current = null; // missing file = creation undone (or deleted since)
    }
    const before = sha256Hex(current ?? "");
    if (before === e.sha256) {
      undone += 1;
      evidence.push(`${e.file}: matches before-image (edit not in the tree)`);
    } else if (!e.existed && current === null) {
      undone += 1;
      evidence.push(`${e.file}: created by the run, now gone`);
    } else {
      live += 1;
      evidence.push(`${e.file}: still differs from before-image (edit live)`);
    }
  }
  let confidence: AutoProposal["confidence"] = undone === 0 || live === 0 ? "high" : "low";
  // Git cross-check: tree dirt the manifest cannot explain means the run (or
  // a later actor) mutated files outside the checkpointed set — any mechanical
  // read of "is the edit live" is then unreliable.
  const git = spawnGitStatus(cwd);
  if (git !== null) {
    const extra = git.filter((f) => !manifestFiles.has(f));
    if (extra.length > 0) {
      confidence = "low";
      evidence.push(`git reports ${extra.length} changed file(s) outside this run's checkpoints (e.g. ${extra.slice(0, 3).join(", ")})`);
    }
  }
  // Mechanical mapping: everything undone → reverted; everything live →
  // accepted (edits survived; tests are the human's call); mixed → edited.
  const verdict: Verdict = live === 0 ? "reverted" : undone === 0 ? "accepted" : "edited";
  return { verdict, confidence, evidence };
}

/** porcelain paths (M/A/D/?? …), or null when git is absent/unusable. */
function spawnGitStatus(cwd: string): string[] | null {
  try {
    const r = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", timeout: 10_000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, "").split("\\").join("/"));
  } catch {
    return null;
  }
}
