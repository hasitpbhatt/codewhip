import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearKey, configDir, resolveKey, saveKey } from "./auth.js";
import { PROVIDER_IDS } from "./provider.js";

const envKey = "CODEWHIP_CONFIG_DIR";
const old = process.env[envKey];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-auth-"));

for (const p of PROVIDER_IDS) {
  delete process.env[`${p.toUpperCase()}_API_KEY`];
}
process.env[envKey] = dir;

describe("auth", () => {
  it("registry supports all four providers", () => {
    strictEqual(PROVIDER_IDS.length, 4);
  });
  it("resolves no key when nothing is stored", () => {
    strictEqual(resolveKey("nvidia").source, "none");
    strictEqual(resolveKey("alibaba").source, "none");
  });
  it("storing one provider preserves every other", () => {
    saveKey("nvidia", "k-nvidia");
    saveKey("mistral", "k-mistral");
    saveKey("sensenova", "k-sensenova");
    saveKey("alibaba", "k-alibaba");
    strictEqual(resolveKey("nvidia").key, "k-nvidia");
    strictEqual(resolveKey("mistral").key, "k-mistral");
    strictEqual(resolveKey("sensenova").key, "k-sensenova");
    strictEqual(resolveKey("alibaba").key, "k-alibaba");
    const read = fs.readFileSync(path.join(configDir(), "credentials.json"), "utf8");
    for (const key of ["k-nvidia", "k-mistral", "k-sensenova", "k-alibaba"]) {
      strictEqual(read.includes(key), true);
    }
  });
  it("clearing one provider leaves the others", () => {
    strictEqual(clearKey("nvidia"), true);
    strictEqual(resolveKey("nvidia").source, "none");
    strictEqual(resolveKey("alibaba").key, "k-alibaba");
    strictEqual(resolveKey("sensenova").key, "k-sensenova");
    strictEqual(clearKey("nvidia"), false);
  });
});