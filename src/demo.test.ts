import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runDenyDemo } from "./demo.js";

describe("demo", () => {
  it("denies five disasters, allows git status, chain verifies, $0 receipt", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-demo-"));
    const r = await runDenyDemo(cwd);
    strictEqual(r.denied, 5);
    strictEqual(r.allowed, 1);
    strictEqual(r.auditValid, true);
    ok(r.receipt.includes("$0.0000"));
    ok(r.runId.length >= 8);
  });
});
