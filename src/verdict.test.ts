import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isVerdict, readVerdictMap, resolveRunPrefix, setVerdict } from "./verdict.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-verdict-"));

function writeOutcome(cwd: string, runId: string): void {
  const dir = path.join(cwd, ".codewhip");
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, "outcomes.jsonl"),
    JSON.stringify({ v: 1, ts: new Date().toISOString(), runId, model: "m", prompt_hash: "p", yolo: false, tool_calls: [], usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null }) + "\n",
    "utf8"
  );
}

describe("verdict", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("accepts only the four enum values", () => {
    ok(isVerdict("accepted"));
    ok(isVerdict("edited"));
    ok(isVerdict("reverted"));
    ok(isVerdict("rejected"));
    strictEqual(isVerdict("good"), false);
    strictEqual(isVerdict(null), false);
  });

  it("stores latest-wins per runId", () => {
    strictEqual(setVerdict(cwd, "r1", "accepted"), true);
    strictEqual(setVerdict(cwd, "r1", "edited"), true);
    strictEqual(readVerdictMap(cwd).get("r1")?.verdict, "edited");
  });

  it("resolves runId prefixes (min 4 chars)", () => {
    writeOutcome(cwd, "abcdef123456");
    strictEqual(resolveRunPrefix(cwd, "abc").length, 0);
    strictEqual(resolveRunPrefix(cwd, "abcd")[0], "abcdef123456");
    strictEqual(resolveRunPrefix(cwd, "zzzz").length, 0);
  });
});
