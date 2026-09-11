import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendPromotedDeny,
  declineCandidates,
  loadPromotedDenies,
  matchesPromoted,
  policyMdPath,
  type PromotedDeny,
} from "./policy-store.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-pstore-"));

const denies: PromotedDeny[] = [
  { tool: "bash", shape: "echo *", line: 1 },
  { tool: "edit", shape: "src/secret.ts", line: 2 },
];

describe("policy-store", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("parses deny lines, ignoring comments/blanks/malformed", () => {
    fs.writeFileSync(
      policyMdPath(cwd),
      "# comment\n\ndeny bash:echo *\ndeny edit:src/a.ts\nallow bash:ls\nbogus line\ndeny broken\n",
      "utf8"
    );
    const loaded = loadPromotedDenies(cwd);
    strictEqual(loaded.length, 2);
    strictEqual(loaded[0]?.tool, "bash");
    strictEqual(loaded[0]?.shape, "echo *");
    strictEqual(loaded[1]?.shape, "src/a.ts");
  });
  it("returns empty when policy.md is missing", () => {
    strictEqual(loadPromotedDenies(cwd).length, 0);
  });
  it("matches bash head shapes without over-matching", () => {
    ok(matchesPromoted("bash", "echo", denies) !== null);
    ok(matchesPromoted("bash", "echo hi", denies) !== null);
    strictEqual(matchesPromoted("bash", "echox", denies), null);
    strictEqual(matchesPromoted("bash", "ls", denies), null);
    strictEqual(matchesPromoted("edit", "echo hi", denies), null);
  });
  it("matches edit shapes exactly", () => {
    ok(matchesPromoted("edit", "src/secret.ts", denies) !== null);
    strictEqual(matchesPromoted("edit", "src/secret.ts.bak", denies), null);
    strictEqual(matchesPromoted("edit", "src/secret", denies), null);
  });
  it("matches interior globs without over-matching", () => {
    const g = [{ tool: "edit", shape: ".env.*", line: 1 }];
    ok(matchesPromoted("edit", ".env.local", g) !== null);
    strictEqual(matchesPromoted("edit", ".env", g), null);
    // Anchored: "src/.env.local" does not match ".env.*" (documented).
    strictEqual(matchesPromoted("edit", "src/.env.local", g), null);
  });
  it("appends idempotently with a header on first write", () => {
    strictEqual(appendPromotedDeny(cwd, "bash", "npm publish *", 3), true);
    strictEqual(appendPromotedDeny(cwd, "bash", "npm publish *", 5), false);
    const raw = fs.readFileSync(policyMdPath(cwd), "utf8");
    ok(raw.includes("deny bash:npm publish *"));
    strictEqual(loadPromotedDenies(cwd).length, 1);
  });
  it("surfaces 3+ declines across 2+ runs as candidates", () => {
    const NOW = Date.parse("2026-09-12T00:00:00.000Z");
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    const call = (seq: number, shape?: string): unknown =>
      ({ seq, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", ...(shape === undefined ? {} : { shape }) });
    const rec = (runId: string, calls: unknown[]): string =>
      JSON.stringify({
        v: 1, ts: "2026-09-11T00:00:00.000Z", runId, model: "m", prompt_hash: "p",
        yolo: false, tool_calls: calls,
        usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null,
      });
    fs.writeFileSync(
      path.join(dir, "outcomes.jsonl"),
      [
        // One run = one record; r1 spams the shape twice but counts once.
        rec("r1", [call(1, "npm publish *"), call(2, "npm publish *")]),
        rec("r2", [call(1, "npm publish *")]),
        rec("r3", [call(1, "npm publish *")]),
        rec("r1", [call(3, "echo hi *")]),
        rec("r2", [call(2, "echo hi *")]),
        rec("r1", [call(4)]),
      ].join("\n") + "\n",
      "utf8"
    );
    const cands = declineCandidates(cwd, 3, NOW);
    strictEqual(cands.length, 1);
    strictEqual(cands[0]?.tool, "bash");
    strictEqual(cands[0]?.shape, "npm publish *");
    strictEqual(cands[0]?.count, 3);
  });
  it("one spamming session cannot mint a candidate alone", () => {
    const NOW = Date.parse("2026-09-12T00:00:00.000Z");
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    // One run, five declines of the same shape: capped to one count AND one
    // distinct run — no candidate either way.
    const calls = [1, 2, 3, 4, 5].map((seq) => (
      { seq, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", shape: "npm publish *" }
    ));
    const rec = JSON.stringify({
      v: 1, ts: "2026-09-11T00:00:00.000Z", runId: "r1", model: "m", prompt_hash: "p",
      yolo: false, tool_calls: calls,
      usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null,
    });
    fs.writeFileSync(path.join(dir, "outcomes.jsonl"), rec + "\n", "utf8");
    strictEqual(declineCandidates(cwd, 3, NOW).length, 0);
  });
  it("ignores declines older than the window", () => {
    const NOW = Date.parse("2026-09-12T00:00:00.000Z");
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    const mk = (runId: string): string =>
      JSON.stringify({
        v: 1, ts: "2026-01-01T00:00:00.000Z", runId, model: "m", prompt_hash: "p",
        yolo: false,
        tool_calls: [{ seq: 1, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", shape: "npm publish *" }],
        usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null,
      });
    fs.writeFileSync(path.join(dir, "outcomes.jsonl"), [mk("r1"), mk("r2"), mk("r3")].join("\n") + "\n", "utf8");
    strictEqual(declineCandidates(cwd, 3, NOW).length, 0);
  });
  it("excludes already-promoted shapes from candidates", () => {
    const NOW = Date.parse("2026-09-12T00:00:00.000Z");
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    const mk = (runId: string): string =>
      JSON.stringify({
        v: 1, ts: "2026-09-11T00:00:00.000Z", runId, model: "m", prompt_hash: "p",
        yolo: false,
        tool_calls: [{ seq: 1, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", shape: "npm publish *" }],
        usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null,
      });
    fs.writeFileSync(path.join(dir, "outcomes.jsonl"), [mk("r1"), mk("r2"), mk("r3")].join("\n") + "\n", "utf8");
    strictEqual(declineCandidates(cwd, 3, NOW).length, 1);
    strictEqual(appendPromotedDeny(cwd, "bash", "npm publish *", 3), true);
    strictEqual(declineCandidates(cwd, 3, NOW).length, 0);
  });
});