import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listPacks, pullPack } from "./pack.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-pack-"));

function seedPack(packsDir: string, name: string, policy: string): void {
  const dir = path.join(packsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "pack.json"), JSON.stringify({ name, version: 2, description: "test pack" }), "utf8");
  fs.writeFileSync(path.join(dir, "policy.md"), policy, "utf8");
}

describe("pack", () => {
  let packsDir: string;
  let cwd: string;
  beforeEach(() => {
    packsDir = tmp();
    cwd = tmp();
    seedPack(packsDir, "starter", "deny bash:npm publish *\n");
  });

  it("lists shipped packs with versions", () => {
    const packs = listPacks(packsDir);
    strictEqual(packs.length, 1);
    strictEqual(packs[0]?.name, "starter");
    strictEqual(packs[0]?.version, 2);
  });
  it("returns empty when the packs dir is missing", () => {
    strictEqual(listPacks(path.join(packsDir, "nope")).length, 0);
  });
  it("pulls policy.md into the cwd", () => {
    const r = pullPack(packsDir, cwd, "starter", false);
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(fs.readFileSync(r.path, "utf8"), "deny bash:npm publish *\n");
    }
  });
  it("refuses to overwrite without --force", () => {
    fs.writeFileSync(path.join(cwd, "policy.md"), "deny bash:x *\n", "utf8");
    const r = pullPack(packsDir, cwd, "starter", false);
    ok("error" in r);
    strictEqual(fs.readFileSync(path.join(cwd, "policy.md"), "utf8"), "deny bash:x *\n");
    const forced = pullPack(packsDir, cwd, "starter", true);
    ok(!("error" in forced));
  });
  it("rejects unknown packs and bad names", () => {
    ok("error" in pullPack(packsDir, cwd, "missing", false));
    ok("error" in pullPack(packsDir, cwd, "../evil", false));
  });
});