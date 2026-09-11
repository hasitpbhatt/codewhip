import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { editTool } from "./edit.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-edit-"));

describe("edit", () => {
  it("returns 'not found' when the file does not exist", async () => {
    const r = await editTool({ cwd }, { path: "nonexistent.md", oldString: "x", newString: "y" });
    strictEqual(r.ok, false);
    strictEqual(r.output.includes("not found"), true);
  });
  it("requires non-empty oldString", async () => {
    const r = await editTool({ cwd }, { path: "x.md", oldString: "", newString: "y" });
    strictEqual(r.ok, false);
    strictEqual(r.output.includes("`oldString` must not be empty"), true);
  });
  it("rejects when oldString matches multiple times", async () => {
    const f = path.join(cwd, "multi.txt");
    fs.writeFileSync(f, "x\nx\n", "utf8");
    const r = await editTool({ cwd }, { path: "multi.txt", oldString: "x", newString: "y" });
    strictEqual(r.ok, false);
    strictEqual(r.output.includes("matches 2 times"), true);
    fs.rmSync(f, { force: true });
  });
  it("applies a single exact match", async () => {
    const f = path.join(cwd, "single.txt");
    fs.writeFileSync(f, "hello world", "utf8");
    const r = await editTool({ cwd }, { path: "single.txt", oldString: "world", newString: "there" });
    strictEqual(r.ok, true);
    strictEqual(fs.readFileSync(f, "utf8"), "hello there");
    fs.rmSync(f, { force: true });
  });
  it("matches blocks in a CRLF file", async () => {
    const f = path.join(cwd, "crlf.txt");
    fs.writeFileSync(f, "alpha\r\nbeta", "utf8");
    const r = await editTool({ cwd }, { path: "crlf.txt", oldString: "alpha\nbeta", newString: "ALPHA\nBETA" });
    strictEqual(r.ok, true);
    strictEqual(fs.readFileSync(f, "utf8"), "ALPHA\nBETA");
    fs.rmSync(f, { force: true });
  });
});
