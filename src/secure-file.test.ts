import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lockFileOwnerOnly, writeOwnerOnlyFile } from "./secure-file.js";

describe("secure-file", () => {
  it("writeOwnerOnlyFile creates owner-only files", () => {
    if (process.platform === "win32") return; // stat-mode assertions are POSIX-only
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-sec-")), "s.txt");
    strictEqual(writeOwnerOnlyFile(p, "secret"), null);
    strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    strictEqual(fs.readFileSync(p, "utf8"), "secret");
  });

  it("lockFileOwnerOnly repairs loose files and warns on missing ones", () => {
    if (process.platform === "win32") return;
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-sec-")), "s.txt");
    fs.writeFileSync(p, "x");
    fs.chmodSync(p, 0o644);
    strictEqual(lockFileOwnerOnly(p), null);
    strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    const missing = lockFileOwnerOnly(path.join(p, "nope"));
    ok(typeof missing === "string" && missing.length > 0, "missing file warns, never throws");
  });
});
