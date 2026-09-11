import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { jailPath } from "./jail.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-jail-"));

describe("jail", () => {
  it("allows a plain file inside the cwd", () => {
    const r = jailPath(cwd, "TEST.md");
    ok(r !== null);
    strictEqual(r?.endsWith("TEST.md"), true);
  });
  it("allows a non-existent path inside the cwd (lazy create)", () => {
    const r = jailPath(cwd, "future.txt");
    ok(r !== null);
    strictEqual(r?.includes("future.txt"), true);
  });
  it("rejects absolute path escape", () => {
    const r = jailPath(cwd, "C:\\Windows\\system32\\cmd.exe");
    strictEqual(r, null);
  });
  it("rejects parent-directory escape via ..", () => {
    const r = jailPath(cwd, "..\\secret.txt");
    strictEqual(r, null);
  });
});
