import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import { DEFAULT_MINER, evaluateRules, mineRules, sampleComplexity, type MinerOptions } from "./miner.js";
import type { LabeledEvent } from "./samples.js";

const COUNT_ONLY: MinerOptions = { ...DEFAULT_MINER, approvalVeto: false };

function ev(
  tool: string,
  shape: string,
  label: "decline" | "approval",
  ts: string,
  runId: string,
  verdict: LabeledEvent["verdict"] = null
): LabeledEvent {
  return {
    ts,
    runId,
    tool,
    shape,
    label,
    ruleId: label === "decline" ? "default:shell:ask+declined" : "default:shell:ask",
    verdict,
  };
}

const declines3 = [
  ev("bash", "curl *", "decline", "2026-09-01T00:00:00Z", "r1"),
  ev("bash", "curl *", "decline", "2026-09-02T00:00:00Z", "r2"),
  ev("bash", "curl *", "decline", "2026-09-03T00:00:00Z", "r3"),
];

describe("immunity/miner", () => {
  it("two-signal mines a repeatedly-declined, never-approved shape", () => {
    const rules = mineRules(declines3, DEFAULT_MINER);
    strictEqual(rules.length, 1);
    strictEqual(rules[0]?.id, "induced:bash:curl *");
    strictEqual(rules[0]?.provenance.declines, 3);
    strictEqual(rules[0]?.provenance.source, "two-signal");
  });

  it("the approval veto is the difference between the two arms", () => {
    const events = [
      ...declines3,
      ev("bash", "curl *", "approval", "2026-09-04T00:00:00Z", "r4"),
      ev("bash", "curl *", "approval", "2026-09-05T00:00:00Z", "r5"),
    ];
    strictEqual(mineRules(events, DEFAULT_MINER).length, 0);
    const countOnly = mineRules(events, COUNT_ONLY);
    strictEqual(countOnly.length, 1);
    const scored = evaluateRules(countOnly, events);
    strictEqual(scored.overblockedApprovals, 2);
    strictEqual(evaluateRules(mineRules(events, DEFAULT_MINER), events).overblockedApprovals, 0);
  });

  it("the veto demands a habit: one misclick — or two regretful ones — cannot disarm a rule", () => {
    const oneMisclick = [...declines3, ev("bash", "curl *", "approval", "2026-09-04T00:00:00Z", "r4")];
    strictEqual(mineRules(oneMisclick, DEFAULT_MINER).length, 1, "single calm approval: rule survives");
    const regretted = [
      ...declines3,
      ev("bash", "curl *", "approval", "2026-09-04T00:00:00Z", "r4", "reverted"),
      ev("bash", "curl *", "approval", "2026-09-05T00:00:00Z", "r5", "rejected"),
    ];
    strictEqual(mineRules(regretted, DEFAULT_MINER).length, 1, "regret approvals never count as veto evidence");
  });

  it("one poisoned session cannot mint a rule (cross-run requirement)", () => {
    const spam = Array.from({ length: 5 }, (_, i): LabeledEvent =>
      ev("bash", "kubectl *", "decline", `2026-09-0${i + 1}T00:00:00Z`, "bad-run")
    );
    strictEqual(mineRules(spam, DEFAULT_MINER).length, 0);
    strictEqual(mineRules(spam, COUNT_ONLY).length, 0);
  });

  it("covers decline events but not other tools' shapes", () => {
    const rules = mineRules(declines3, DEFAULT_MINER);
    const events = [
      ...declines3,
      ev("bash", "wget *", "decline", "2026-09-04T00:00:00Z", "r4"),
    ];
    const s = evaluateRules(rules, events);
    strictEqual(s.coveredDeclines, 3);
    strictEqual(s.declineEvents, 4);
    strictEqual(s.coverageRate, 0.75);
  });

  it("sample-complexity curve: one point per event, ends at the two-signal optimum", () => {
    const events = [
      ...declines3,
      ev("bash", "curl *", "approval", "2026-09-04T00:00:00Z", "r4"),
      ev("bash", "curl *", "approval", "2026-09-05T00:00:00Z", "r5"),
    ];
    const curve = sampleComplexity(events, DEFAULT_MINER);
    strictEqual(curve.length, events.length);
    strictEqual(curve[0]?.declinesSeen, 1);
    const last = curve[curve.length - 1] as { overblockRate: number };
    strictEqual(last.overblockRate, 0);
  });

  it("window expires stale signals", () => {
    const nowMs = Date.parse("2026-09-20T00:00:00Z");
    const opts: MinerOptions = { ...DEFAULT_MINER, nowMs, windowMs: 30 * 24 * 3600 * 1000 };
    strictEqual(mineRules(declines3, opts).length, 1, "recent declines still mine");
    const old = declines3.map((e) => ({ ...e, ts: e.ts.replace("2026-09", "2025-09") }));
    strictEqual(mineRules(old, opts).length, 0);
  });

  it("verdicts weight the declines: reverted runs teach twice as fast", () => {
    const reverted = [
      ev("bash", "kubectl *", "decline", "2026-09-01T00:00:00Z", "r1", "reverted"),
      ev("bash", "kubectl *", "decline", "2026-09-02T00:00:00Z", "r2", "reverted"),
    ];
    strictEqual(mineRules(reverted, DEFAULT_MINER).length, 1, "2 declined-reverted runs fire (score 4)");
    const accepted = reverted.map((e) => ({ ...e, verdict: "accepted" as const }));
    strictEqual(mineRules(accepted, DEFAULT_MINER).length, 0, "2 declined-accepted runs stay below (score 1)");
  });
});
