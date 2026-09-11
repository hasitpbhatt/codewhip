import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { appendOutcome, newRunId, readLastOutcomes } from "./outcomes.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-out-"));

describe("outcomes", () => {
  it("readLastOutcomes tails newest N of the chain", () => {
    const cwd = tmp();
    const base = {
      v: 1 as const,
      ts: "",
      runId: newRunId(),
      model: "m",
      prompt_hash: "h",
      yolo: false,
      tool_calls: [],
      usage: { prompt: 1, completion: 1 },
      result_preview_redacted: "one",
      verdict: null as null,
    };
    strictEqual(appendOutcome(cwd, { ...base, ts: "a", result_preview_redacted: "one" }), true);
    strictEqual(appendOutcome(cwd, { ...base, ts: "b", result_preview_redacted: "two" }), true);
    const tail = readLastOutcomes(cwd, 1);
    ok(tail.includes('"two"'), tail);
    ok(!tail.includes('"one"'), tail);
    strictEqual(tail.split("\n").length, 1);
  });
  it("readLastOutcomes returns empty for a fresh dir", () => {
    strictEqual(readLastOutcomes(tmp(), 5), "");
  });
});