import { describe, it, beforeEach, afterEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isVerdict, proposeVerdict, readVerdictMap, resolveRunPrefix, setVerdict } from "./verdict.js";
import { saveCheckpoint, type BeforeImage } from "./checkpoints.js";

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

describe("verdict --auto proposal (checkpoints vs the tree)", () => {
  let cwd: string;
  const RUN = "11112222-3333-4444-5555-666677778888";
  beforeEach(() => {
    cwd = tmp();
  });
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  function cap(rel: string, content: string | null): BeforeImage {
    return { rel, abs: path.join(cwd, rel), content };
  }

  it("proposes accepted (high confidence) when the run's edits are still live", () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "before");
    ok(saveCheckpoint(cwd, RUN, 1, cap("a.txt", "before")));
    fs.writeFileSync(path.join(cwd, "a.txt"), "after the run");
    const p = proposeVerdict(cwd, RUN);
    ok(!("error" in p), "error" in p ? p.error : "");
    strictEqual(p.verdict, "accepted");
    strictEqual(p.confidence, "high");
  });

  it("proposes reverted when every file is back at its before-image", () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "before");
    ok(saveCheckpoint(cwd, RUN, 1, cap("a.txt", "before")));
    // Edited, then rolled back — content equals the before-image again.
    fs.writeFileSync(path.join(cwd, "a.txt"), "before");
    const p = proposeVerdict(cwd, RUN);
    ok(!("error" in p));
    strictEqual(p.verdict, "reverted");
    strictEqual(p.confidence, "high");
  });

  it("a created file that was deleted counts as undone", () => {
    ok(saveCheckpoint(cwd, RUN, 1, cap("new.txt", null)));
    const p = proposeVerdict(cwd, RUN);
    ok(!("error" in p));
    strictEqual(p.verdict, "reverted");
  });

  it("mixed state proposes edited with low confidence", () => {
    fs.writeFileSync(path.join(cwd, "a.txt"), "before");
    ok(saveCheckpoint(cwd, RUN, 1, cap("a.txt", "before")));
    ok(saveCheckpoint(cwd, RUN, 2, cap("b.txt", null)));
    fs.writeFileSync(path.join(cwd, "a.txt"), "still live");
    // b.txt created then deleted — undone.
    const p = proposeVerdict(cwd, RUN);
    ok(!("error" in p));
    strictEqual(p.verdict, "edited");
    strictEqual(p.confidence, "low");
  });

  it("refuses to propose for a run with no checkpoints", () => {
    const p = proposeVerdict(cwd, RUN);
    ok("error" in p);
    ok(p.error.includes("no checkpoints"));
  });
});
