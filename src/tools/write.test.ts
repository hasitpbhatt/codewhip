import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeTool, refusesSelfProtected } from "./write.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-write-"));

describe("write", () => {
  it("creates a new file with parent dirs", async () => {
    const r = await writeTool({ cwd }, { path: "a/b/c.txt", content: "hello" });
    strictEqual(r.ok, true);
    strictEqual(fs.readFileSync(path.join(cwd, "a", "b", "c.txt"), "utf8"), "hello");
  });
  it("overwrites an existing file", async () => {
    fs.writeFileSync(path.join(cwd, "over.txt"), "old", "utf8");
    const r = await writeTool({ cwd }, { path: "over.txt", content: "new" });
    strictEqual(r.ok, true);
    strictEqual(fs.readFileSync(path.join(cwd, "over.txt"), "utf8"), "new");
  });
  it("refuses content over 1MB", async () => {
    const r = await writeTool({ cwd }, { path: "big.txt", content: "x".repeat(1024 * 1024 + 1) });
    strictEqual(r.ok, false);
  });
  it("refuses writes into .codewhip", async () => {
    const r = await writeTool({ cwd }, { path: ".codewhip/remembered.jsonl", content: "{}" });
    strictEqual(r.ok, false);
  });
  it("refuses codewhip-policy.yaml", async () => {
    const r = await writeTool({ cwd }, { path: "codewhip-policy.yaml", content: "x" });
    strictEqual(r.ok, false);
  });
  it("rejects path escaping the jail", async () => {
    const r = await writeTool({ cwd }, { path: "../secret.txt", content: "x" });
    strictEqual(r.ok, false);
  });
  it("refusesSelfProtected flags .codewhip and policy files", () => {
    strictEqual(refusesSelfProtected(path.join(cwd, ".codewhip", "remembered.jsonl")), true);
    strictEqual(refusesSelfProtected(path.join(cwd, "codewhip-policy.yaml")), true);
    strictEqual(refusesSelfProtected(path.join(cwd, "policy.md")), true);
    strictEqual(refusesSelfProtected(path.join(cwd, "src", "main.ts")), false);
  });
});