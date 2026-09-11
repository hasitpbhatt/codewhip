import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTool } from "./read.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-read-"));

describe("read", () => {
  it("reads a file with line numbers", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.txt"), "one\ntwo\n");
    const r = await readTool({ cwd }, { path: "a.txt" });
    strictEqual(r.ok, true);
    ok(r.output.includes("1: one"));
  });
  it("refuses secret material", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, ".env"), "K=1\n");
    const r = await readTool({ cwd }, { path: ".env" });
    strictEqual(r.ok, false);
    ok(r.output.includes("secret material"));
  });
  it("refuses the harness signing key", async () => {
    const cwd = tmp();
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "key"), "private\n");
    const r = await readTool({ cwd }, { path: ".codewhip/key" });
    strictEqual(r.ok, false);
    ok(r.output.includes("signing key"));
  });
});