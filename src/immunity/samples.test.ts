import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendOutcome, type OutcomeRecord } from "../outcomes.js";
import { readLabeledEvents, shapeStats, splitEvents } from "./samples.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-imm-"));

function rec(partial: Partial<OutcomeRecord> & Pick<OutcomeRecord, "runId">): OutcomeRecord {
  return {
    v: 1,
    ts: "2026-09-20T00:00:00.000Z",
    model: "test/model",
    prompt_hash: "x",
    yolo: false,
    tool_calls: [],
    usage: { prompt: 1, completion: 1 },
    result_preview_redacted: "",
    verdict: null,
    ...partial,
  };
}

describe("immunity/samples", () => {
  it("extracts declines and human approvals, ignoring un-labeled grants", () => {
    const cwd = tmp();
    appendOutcome(cwd, rec({
      runId: "r1",
      tool_calls: [
        { seq: 1, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", shape: "curl *" },
        { seq: 2, tool: "bash", args_hash: "c", result_hash: "d", decision: "allow", ruleId: "default:shell:ask", shape: "git push origin *" },
        { seq: 3, tool: "bash", args_hash: "e", result_hash: "f", decision: "allow", ruleId: "allowlist:ls" },
        { seq: 4, tool: "bash", args_hash: "g", result_hash: "h", decision: "deny", ruleId: "denylist:rm -rf /" },
        { seq: 5, tool: "bash", args_hash: "i", result_hash: "j", decision: "deny", ruleId: "default:shell:ask+held", shape: "npm publish *" },
      ],
    }));
    const events = readLabeledEvents(cwd);
    strictEqual(events.length, 2);
    strictEqual(events[0]?.label, "decline");
    strictEqual(events[0]?.shape, "curl *");
    strictEqual(events[1]?.label, "approval");
    strictEqual(events[1]?.ruleId, "default:shell:ask");
  });

  it("joins the run verdict for the training stream", () => {
    const cwd = tmp();
    appendOutcome(cwd, rec({
      runId: "r2",
      tool_calls: [{ seq: 1, tool: "edit", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:edit:ask+declined", shape: "src/gen.ts" }],
    }));
    fs.appendFileSync(
      path.join(cwd, ".codewhip", "verdicts.jsonl"),
      JSON.stringify({ v: 1, ts: "2026-09-20T01:00:00.000Z", runId: "r2", verdict: "reverted" }) + "\n",
      "utf8"
    );
    const events = readLabeledEvents(cwd);
    strictEqual(events[0]?.verdict, "reverted");
  });

  it("shapeStats counts declines, approvals, and distinct runs", () => {
    const cwd = tmp();
    appendOutcome(cwd, rec({
      runId: "ra",
      ts: "2026-09-19T00:00:00.000Z",
      tool_calls: [
        { seq: 1, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", shape: "curl *" },
        { seq: 2, tool: "bash", args_hash: "c", result_hash: "d", decision: "allow", ruleId: "default:shell:ask+session", shape: "curl *" },
      ],
    }));
    appendOutcome(cwd, rec({
      runId: "rb",
      ts: "2026-09-20T00:00:00.000Z",
      tool_calls: [
        { seq: 1, tool: "bash", args_hash: "e", result_hash: "f", decision: "deny", ruleId: "default:shell:ask+declined", shape: "curl *" },
      ],
    }));
    const stats = shapeStats(readLabeledEvents(cwd));
    strictEqual(stats.length, 1);
    strictEqual(stats[0]?.declines, 2);
    strictEqual(stats[0]?.approvals, 1);
    strictEqual(stats[0]?.runs, 2);
    strictEqual(stats[0]?.firstTs, "2026-09-19T00:00:00.000Z");
  });

  it("approvals are pinned by ruleId: yolo/remembered grants with a shape never count", () => {
    const cwd = tmp();
    appendOutcome(cwd, rec({
      runId: "r3",
      tool_calls: [
        { seq: 1, tool: "bash", args_hash: "a", result_hash: "b", decision: "allow", ruleId: "default:shell:ask+yolo", shape: "sudo *" },
        { seq: 2, tool: "bash", args_hash: "c", result_hash: "d", decision: "allow", ruleId: "default:shell:ask+remembered", shape: "ls *" },
        { seq: 3, tool: "bash", args_hash: "e", result_hash: "f", decision: "allow", ruleId: "default:shell:ask+session", shape: "docker *" },
        { seq: 4, tool: "bash", args_hash: "g", result_hash: "h", decision: "allow", ruleId: "default:shell:ask+always", shape: "pnpm *" },
      ],
    }));
    const events = readLabeledEvents(cwd);
    strictEqual(events.map((e) => e.shape).join(","), "docker *,pnpm *");
  });

  it("splitEvents is chronological and total", () => {
    const events = ["2026-09-02", "2026-09-01", "2026-09-03", "2026-09-04"].map((d, i) => ({
      ts: `${d}T00:00:00Z`,
      runId: `r${i}`,
      tool: "bash",
      shape: "curl *",
      label: "decline" as const,
      ruleId: "default:shell:ask+declined",
      verdict: null,
    }));
    const { train, heldOut } = splitEvents(events, 0.5);
    strictEqual(train.length, 2);
    strictEqual(heldOut.length, 2);
    strictEqual(train[0]?.ts, "2026-09-01T00:00:00Z");
    strictEqual(heldOut[0]?.ts, "2026-09-03T00:00:00Z");
  });

  it("empty/missing outcomes yield no events", () => {
    ok(readLabeledEvents(tmp()).length === 0);
  });
});
