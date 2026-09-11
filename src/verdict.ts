import * as fs from "node:fs";
import * as path from "node:path";

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

/** Resolve a (possibly short) runId prefix to full ids. Empty when no match. */
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
