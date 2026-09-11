import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { searchTool } from "./search.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-search-"));

describe("search", () => {
  it("finds matches with file:line context", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.ts"), "const x = 1;\n");
    fs.writeFileSync(path.join(cwd, "b.md"), "no match here\n");
    const r = await searchTool({ cwd }, { query: "const x" });
    strictEqual(r.ok, true);
    ok(r.output.includes("a.ts:1"));
    ok(!r.output.includes("b.md"));
  });
  it("stops scanning when the byte budget is exhausted", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.txt"), "xxxxxx pelican\n");
    fs.writeFileSync(path.join(cwd, "b.txt"), "xxxxxx albatross\n");
    fs.writeFileSync(path.join(cwd, "c.txt"), "xxxxxx osprey\n");
    const r = await searchTool({ cwd }, { query: "pelican" }, { maxScanBytes: 15 });
    strictEqual(r.ok, true);
    ok(r.output.includes("a.txt:1"));
    ok(!r.output.includes("c.txt"));
    ok(r.output.includes("scan budget"), r.output);
  });
  it("feeds only the capped line prefix to the regex", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.txt"), "aaaaaaxxx\n");
    const r = await searchTool({ cwd }, { query: "xxx" }, { maxLineChars: 6 });
    strictEqual(r.ok, true);
    strictEqual(r.output, "no matches");
  });
});