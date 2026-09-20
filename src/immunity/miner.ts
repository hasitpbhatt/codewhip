import { shapeStats, type LabeledEvent } from "./samples.js";
import { ruleWouldOverBlock, ruleSetMatcher, shapeToPredicate, type InducedRule } from "./rules.js";

/**
 * The two-signal miner v0 (docs/moat/15-agent-physiology.md C3).
 *
 * Co-stimulation: a rule is induced only when BOTH signals fire —
 * the policy engine flagged the shape repeatedly across runs (near-miss
 * pattern, one counted decline per run per shape so one poisoned session
 * can't mint coverage) AND the human declined it repeatedly. The tolerance
 * arm is the approval veto: a rule that would have denied any observed
 * approval is refused at induction time, not merely measured at eval time.
 *
 * `approvalVeto: false` is the count-only ablation arm (the current
 * promotion rule generalized) — the paper's one-signal baseline.
 *
 * The veto is verdict-aware: an approval from a run later REVERTED or
 * REJECTED is regret (a misclick the outcome punished), not evidence the
 * rule over-blocks, so it cannot veto. Without this, one 1-in-20 misclick
 * permanently poisons a true-danger rule (pinned by simuser).
 */
export type MinerOptions = {
  /** Weighted decline score required to fire a rule (see verdictWeights). */
  threshold: number;
  /** Distinct runs the declines must span (cross-run = not one bad session). */
  minRuns: number;
  /** Two-signal mode refuses rules covering an observed approval. */
  approvalVeto: boolean;
  /** Distinct calm-approval runs needed to veto (1 = any single yes kills
   * the rule; the default demands a habit, not a misclick). */
  vetoMinRuns: number;
  /**
   * Verdict-driven weighting: a decline inside a run the human later
   * REVERTED or REJECTED is stronger evidence the decline was right
   * (weight > 1); a decline from a run that was ACCEPTED is weaker — the
   * agent recovered without it (weight < 1). Judged runs therefore teach
   * faster than unjudged ones; unjudged default to 1 (pure one-bit count).
   */
  verdictWeights: Record<"reverted" | "rejected" | "accepted" | "edited", number>;
  /** Only count signals newer than nowMs - windowMs (default: no window). */
  windowMs?: number;
  nowMs?: number;
};

export const DEFAULT_MINER: MinerOptions = {
  threshold: 3,
  minRuns: 2,
  approvalVeto: true,
  vetoMinRuns: 2,
  verdictWeights: { reverted: 2, rejected: 2, accepted: 0.5, edited: 1 },
};

/** One contribution per (shape, run) — the run's max-weighted decline. */
function declineRunWeights(
  events: LabeledEvent[],
  weights: MinerOptions["verdictWeights"]
): Map<string, Map<string, number>> {
  const m = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.label !== "decline") continue;
    const w = e.verdict === null ? 1 : weights[e.verdict];
    const key = `${e.tool}:${e.shape}`;
    const runs = m.get(key) ?? new Map<string, number>();
    if ((runs.get(e.runId) ?? 0) < w) runs.set(e.runId, w);
    m.set(key, runs);
  }
  return m;
}

export function mineRules(events: LabeledEvent[], opts: MinerOptions = DEFAULT_MINER): InducedRule[] {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? Number.POSITIVE_INFINITY;
  const fresh = events.filter((e) => {
    const t = Date.parse(e.ts);
    return Number.isFinite(t) && nowMs - t <= windowMs && t <= nowMs;
  });
  const runs = declineRunWeights(fresh, opts.verdictWeights);
  const approvals = fresh.filter((e) => e.label === "approval");
  // Regret-polarized veto: only approvals from runs the human did NOT
  // revert/reject count as over-block evidence.
  const vetoApprovals = approvals.filter((e) => e.verdict !== "reverted" && e.verdict !== "rejected");
  const out: InducedRule[] = [];
  for (const s of shapeStats(fresh)) {
    const runW = runs.get(`${s.tool}:${s.shape}`);
    if (runW === undefined || runW.size < opts.minRuns) continue;
    let score = 0;
    for (const w of runW.values()) score += w;
    if (score < opts.threshold) continue;
    const rule: InducedRule = {
      id: `induced:${s.tool}:${s.shape}`,
      tool: s.tool,
      predicate: shapeToPredicate(s.tool, s.shape),
      effect: "deny",
      provenance: {
        declines: runW.size,
        approvals: s.approvals,
        runs: s.runs,
        source: opts.approvalVeto ? "two-signal" : "count-only",
      },
    };
    if (opts.approvalVeto && ruleWouldOverBlock(rule, vetoApprovals, opts.vetoMinRuns)) continue;
    out.push(rule);
  }
  out.sort((a, b) => b.provenance.declines - a.provenance.declines || a.id.localeCompare(b.id));
  return out;
}

export type RuleEval = {
  rules: number;
  declineEvents: number;
  coveredDeclines: number;
  coverageRate: number;
  approvalEvents: number;
  overblockedApprovals: number;
  overblockRate: number;
};

/** Score a rule set against the labeled stream: coverage vs autoimmune cost. */
export function evaluateRules(rules: InducedRule[], events: LabeledEvent[]): RuleEval {
  const m = ruleSetMatcher(rules);
  let declineEvents = 0, coveredDeclines = 0, approvalEvents = 0, overblockedApprovals = 0;
  for (const e of events) {
    if (e.label === "decline") {
      declineEvents += 1;
      if (m.matches(e.tool, e.shape)) coveredDeclines += 1;
    } else {
      approvalEvents += 1;
      if (m.matches(e.tool, e.shape)) overblockedApprovals += 1;
    }
  }
  return {
    rules: rules.length,
    declineEvents,
    coveredDeclines,
    coverageRate: declineEvents === 0 ? 0 : coveredDeclines / declineEvents,
    approvalEvents,
    overblockedApprovals,
    overblockRate: approvalEvents === 0 ? 0 : overblockedApprovals / approvalEvents,
  };
}

export type CurvePoint = {
  /** Decline events observed so far (chronological prefix length). */
  declinesSeen: number;
  totalEvents: number;
  rulesMined: number;
  coverageRate: number;
  overblockRate: number;
};

/**
 * Sample-complexity curve: for each chronological prefix, mine on that
 * prefix and score against the FULL stream. This is the paper's
 * declines-to-coverage figure — x = human bits spent, y = future protection
 * bought, autoimmune cost reported per point (evaluated with the prefix's
 * veto state, so count-only mode can show over-block growing where
 * two-signal stays at zero).
 */
export function sampleComplexity(events: LabeledEvent[], opts: MinerOptions = DEFAULT_MINER): CurvePoint[] {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const points: CurvePoint[] = [];
  let declinesSeen = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const prefix = sorted.slice(0, i);
    const cur = prefix[i - 1] as LabeledEvent;
    if (cur.label === "decline") declinesSeen += 1;
    const rules = mineRules(prefix, opts);
    const evalRes = evaluateRules(rules, sorted);
    points.push({
      declinesSeen,
      totalEvents: sorted.length,
      rulesMined: rules.length,
      coverageRate: evalRes.coverageRate,
      overblockRate: evalRes.overblockRate,
    });
  }
  return points;
}
