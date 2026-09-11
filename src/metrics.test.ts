import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { renderMetrics, summarize } from "./metrics.js";
import type { OutcomeRecord } from "./outcomes.js";

const NOW = Date.parse("2026-09-11T12:00:00.000Z");

const rec = (over: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
  v: 1,
  ts: "2026-09-10T12:00:00.000Z",
  runId: "r1",
  model: "moonshotai/kimi-k3",
  prompt_hash: "p",
  yolo: false,
  tool_calls: [],
  usage: { prompt: 0, completion: 0 },
  result_preview_redacted: "",
  verdict: null,
  ...over,
});

describe("metrics", () => {
  it("reports empty state with no runs", () => {
    const s = summarize([], 0, null, NOW);
    strictEqual(s.runs, 0);
    ok(renderMetrics(s).includes("no runs yet"));
  });
  it("counts decisions and blocks-per-100", () => {
    const s = summarize(
      [
        rec({
          tool_calls: [
            { seq: 1, tool: "read", args_hash: "a", result_hash: "b", decision: "allow", ruleId: "default:read:allow" },
            { seq: 2, tool: "bash", args_hash: "c", result_hash: "d", decision: "deny", ruleId: "denylist:rm-rf /" },
          ],
        }),
        rec({ runId: "r2" }),
      ],
      0,
      null,
      NOW
    );
    strictEqual(s.runs, 2);
    strictEqual(s.toolCalls, 2);
    strictEqual(s.allowed, 1);
    strictEqual(s.denied, 1);
    strictEqual(s.blocksPer100, 50);
    ok(renderMetrics(s).includes("50.0 blocks/100 runs"));
  });
  it("prices known routes, counts the rest untracked", () => {
    const s = summarize(
      [
        rec({
          usageByModel: [{ label: "nvidia", model: "moonshotai/kimi-k3", prompt: 1000, completion: 500 }],
        }),
        rec({
          runId: "r2",
          usageByModel: [{ label: "sensenova", model: "sensenova-6.8-flash-lite", prompt: 1000, completion: 500 }],
        }),
        rec({ runId: "r3" }),
      ],
      0,
      null,
      NOW
    );
    strictEqual(s.pricedRuns, 1);
    strictEqual(s.pricedCost, 0);
    strictEqual(s.untrackedRuns, 2);
    ok(renderMetrics(s).includes("untracked"));
  });
  it("reports memory lines per week from the oldest rule", () => {
    const s = summarize([], 14, "2026-08-28T12:00:00.000Z", NOW);
    strictEqual(s.memoryLines, 14);
    ok(Math.abs(s.memoryPerWeek - 7) < 0.01, String(s.memoryPerWeek));
  });
  it("reports task success unmeasurable without verdicts", () => {
    const s = summarize([rec()], 0, null, NOW);
    strictEqual(s.verdicts, 0);
    strictEqual(s.successRate, null);
    ok(renderMetrics(s).includes("unmeasurable"));
  });
  it("computes accepted-rate once verdicts exist", () => {
    const s = summarize([rec({ verdict: "accepted" }), rec({ runId: "r2", verdict: "reverted" })], 0, null, NOW);
    strictEqual(s.verdicts, 2);
    strictEqual(s.successRate, 0.5);
    ok(renderMetrics(s).includes("50% accepted"));
  });
});