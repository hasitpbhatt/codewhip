import { readOutcomeRecords } from "../outcomes.js";
import { readVerdictMap, type Verdict } from "../verdict.js";

/**
 * Labeled permission events — the training stream for verdict-driven
 * privilege (docs/moat/15-agent-physiology.md C3).
 *
 * Every human answer to the permission ladder is one bit, and outcomes.jsonl
 * already carries it: declines record a generalizable deny shape, approvals
 * (since the 2026-09-20 immunity telemetry) record the same shape as a
 * positive sample. yolo/remembered/held grants carry no fresh human bit and
 * are excluded by construction — they never produce a labeled shape.
 *
 * Coverage boundary of the shape language: chained/unmemorable subjects
 * (UNMEMORABLE_RX in policy.ts) carry no shape, so they never appear here.
 * The deny side catches them structurally via CHAIN_RX; the miner cannot
 * learn them — a stated limitation, not a bug.
 */
export type LabeledEvent = {
  ts: string;
  runId: string;
  tool: string;
  shape: string;
  /** "decline" = human said no (negative for the shape). "approval" = human
   * said yes to an ask (positive: any rule denying this shape over-blocks). */
  label: "decline" | "approval";
  /** Rule pointer that produced the ask/deny (e.g. "default:shell:ask+declined"). */
  ruleId: string;
  /** Run-level outcome verdict (accepted/edited/reverted/...), null until judged. */
  verdict: Verdict | null;
  taskClass?: string;
};

/** Bare human yes, or the session/always suffixes — and only those. */
const ASK_GRANT_RX = /^default:(?:shell|edit|write|webfetch):ask(\+(?:session|always))?$/;

export function readLabeledEvents(cwd: string): LabeledEvent[] {
  const verdicts = readVerdictMap(cwd);
  const out: LabeledEvent[] = [];
  for (const r of readOutcomeRecords(cwd)) {
    const verdict = verdicts.get(r.runId)?.verdict ?? r.verdict ?? null;
    for (const c of r.tool_calls ?? []) {
      if (typeof c.shape !== "string" || c.shape.length === 0) continue;
      const declined = c.decision === "deny" && c.ruleId.endsWith("+declined");
      // Positives are pinned by ruleId, not by trust: exactly the three
      // human answers to an ask (bare yes, +session, +always). A shape on
      // any other allow grant (+yolo, +remembered, allowlist, future paths)
      // is no fresh human bit and must never enter the positive class.
      const approved = c.decision === "allow" && ASK_GRANT_RX.test(c.ruleId);
      if (!declined && !approved) continue;
      out.push({
        ts: r.ts,
        runId: r.runId,
        tool: c.tool,
        shape: c.shape,
        label: declined ? "decline" : "approval",
        ruleId: c.ruleId,
        verdict,
        ...(r.task_class === undefined ? {} : { taskClass: r.task_class }),
      });
    }
  }
  out.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.runId < b.runId ? -1 : 1));
  return out;
}

export type ShapeStats = {
  tool: string;
  shape: string;
  declines: number;
  approvals: number;
  /** Distinct runIds that produced either signal — coverage needs ≥2. */
  runs: number;
  firstTs: string;
  lastTs: string;
};

/** Collapse the event stream into per-(tool,shape) statistics. */
export function shapeStats(events: LabeledEvent[]): ShapeStats[] {
  const m = new Map<string, ShapeStats & { runSet: Set<string> }>();
  for (const e of events) {
    const key = `${e.tool}:${e.shape}`;
    let s = m.get(key);
    if (s === undefined) {
      s = { tool: e.tool, shape: e.shape, declines: 0, approvals: 0, runs: 0, runSet: new Set(), firstTs: e.ts, lastTs: e.ts };
      m.set(key, s);
    }
    if (e.label === "decline") s.declines += 1;
    else s.approvals += 1;
    s.runSet.add(e.runId);
    if (e.ts < s.firstTs) s.firstTs = e.ts;
    if (e.ts > s.lastTs) s.lastTs = e.ts;
  }
  const out = [...m.values()].map(({ runSet, ...rest }) => ({ ...rest, runs: runSet.size }));
  out.sort((a, b) => b.declines - a.declines || a.tool.localeCompare(b.tool) || a.shape.localeCompare(b.shape));
  return out;
}

/**
 * Chronological train/held-out split. Induction only ever sees the past
 * (that is what an online harness can do), so generalization must be
 * measured forward in time, never by re-scoring the training stream.
 */
export function splitEvents(
  events: LabeledEvent[],
  trainFrac = 0.7
): { train: LabeledEvent[]; heldOut: LabeledEvent[] } {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.runId < b.runId ? -1 : 1));
  const cut = Math.min(sorted.length, Math.max(0, Math.round(sorted.length * trainFrac)));
  return { train: sorted.slice(0, cut), heldOut: sorted.slice(cut) };
}
