import { describe, it, after } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listRules, persistRule } from "./remember-store.js";
import { randomUUID } from "node:crypto";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-remember-"));
after(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

describe("remember-store", () => {
  it("listRules returns empty for a clean cwd", () => {
    const rules = listRules(cwd);
    strictEqual(Array.isArray(rules), true);
  });
  it("persistRule appends and listRules reads it back", () => {
    const runId = randomUUID();
    const result = persistRule(cwd, runId, {
      tool: "bash", shape: "ls *", ts: new Date().toISOString(), runId, preview_hash: "abc123",
    });
    strictEqual(result, "added");
    const rules = listRules(cwd);
    strictEqual(rules.length >= 1, true);
    const last = rules[rules.length - 1];
    strictEqual(last.tool, "bash");
    strictEqual(last.shape, "ls *");
    strictEqual(last.runId, runId);
  });
  it("persistRule is idempotent (duplicate returns exists)", () => {
    const result = persistRule(cwd, randomUUID(), {
      tool: "bash", shape: "ls *", ts: new Date().toISOString(), runId: randomUUID(), preview_hash: "abc123",
    });
    strictEqual(result, "exists");
  });
  it("each persisted rule carries provenance", () => {
    const rules = listRules(cwd);
    const lsRule = rules.find((r) => r.shape === "ls *");
    ok(lsRule);
    strictEqual(typeof lsRule.ts, "string");
    strictEqual(typeof lsRule.runId, "string");
    strictEqual(typeof lsRule.preview_hash, "string");
  });
  it("drops injected and provenance-free rules on load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-remember-evil-"));
    const file = path.join(dir, ".codewhip", "remembered.jsonl");
    fs.mkdirSync(path.join(dir, ".codewhip"), { recursive: true });
    const good = { tool: "bash", shape: "ls *", ts: new Date().toISOString(), runId: "r", preview_hash: "h" };
    const evil = { tool: "bash", shape: "rm *", ts: new Date().toISOString(), runId: "r", preview_hash: "h" };
    const noproof = { tool: "bash", shape: "ls *", ts: new Date().toISOString(), runId: "r" };
    fs.writeFileSync(file, [JSON.stringify(good), JSON.stringify(evil), JSON.stringify(noproof), "junk"].join("\n") + "\n", "utf8");
    const rules = listRules(dir);
    strictEqual(rules.length, 1);
    strictEqual(rules[0]?.shape, "ls *");
  });
});
