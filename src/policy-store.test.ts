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
  it("surfaces 3+ declines of the same shape as candidates", () => {
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    const line = (seq: number, shape?: string): string =>
      JSON.stringify({
        v: 1, ts: "2026-09-11T00:00:00.000Z", runId: "r", model: "m", prompt_hash: "p",
        yolo: false,
        tool_calls: [{ seq, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", ...(shape === undefined ? {} : { shape }) }],
        usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null,
      });
    fs.writeFileSync(
      path.join(dir, "outcomes.jsonl"),
      [line(1, "npm publish *"), line(2, "npm publish *"), line(3, "npm publish *"), line(4, "echo *"), line(5, "echo *"), line(6)].join("\n") + "\n",
      "utf8"
    );
    const cands = declineCandidates(cwd);
    strictEqual(cands.length, 1);
    strictEqual(cands[0]?.tool, "bash");
    strictEqual(cands[0]?.shape, "npm publish *");
    strictEqual(cands[0]?.count, 3);
  });
  it("excludes already-promoted shapes from candidates", () => {
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    const mk = (): string =>
      JSON.stringify({
        v: 1, ts: "2026-09-11T00:00:00.000Z", runId: "r", model: "m", prompt_hash: "p",
        yolo: false,
        tool_calls: [{ seq: 1, tool: "bash", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "default:shell:ask+declined", shape: "npm publish *" }],
        usage: { prompt: 0, completion: 0 }, result_preview_redacted: "", verdict: null,
      });
    fs.writeFileSync(path.join(dir, "outcomes.jsonl"), [mk(), mk(), mk()].join("\n") + "\n", "utf8");
    strictEqual(declineCandidates(cwd).length, 1);
    strictEqual(appendPromotedDeny(cwd, "bash", "npm publish *", 3), true);
    strictEqual(declineCandidates(cwd).length, 0);
  });
});