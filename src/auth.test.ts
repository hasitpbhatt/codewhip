import { describe, it } from "node:test";
import { strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearKey, configDir, resolveKey, saveKey } from "./auth.js";
import { PROVIDER_IDS } from "./provider.js";

const envKey = "CODEWHIP_CONFIG_DIR";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-auth-"));

for (const p of PROVIDER_IDS) {
  delete process.env[`${p.toUpperCase()}_API_KEY`];
}
process.env[envKey] = dir;

describe("auth", () => {
  it("registry supports every builtin provider", () => {
    strictEqual(PROVIDER_IDS.length, 134);
  });
  it("keyless free tiers fall back to their verified anonymous keys", () => {
    strictEqual(resolveKey("kilo").source, "anonymous");
    strictEqual(resolveKey("kilo").key, "anonymous");
    strictEqual(resolveKey("opencode").source, "anonymous");
    strictEqual(resolveKey("opencode").key, "public");
    strictEqual(resolveKey("empero").source, "anonymous");
    strictEqual(resolveKey("empero").key, "free");
    strictEqual(resolveKey("pollinations").source, "anonymous");
    strictEqual(resolveKey("pollinations").key, "unused");
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
  it("llm7 falls back to anonymous access when no key is stored", () => {
    const r = resolveKey("llm7");
    strictEqual(r.source, "anonymous");
    strictEqual(r.key, "unused");
  });
  it("tokenharbor needs a key (no anonymous fallback)", () => {
    strictEqual(resolveKey("tokenharbor").source, "none");
  });
  it("bai and fabryka need keys (no anonymous fallback)", () => {
    strictEqual(resolveKey("bai").source, "none");
    strictEqual(resolveKey("fabryka").source, "none");
  });
  it("custom provider keys persist without dropping builtins", () => {
    saveKey("my-custom", "k-custom");
    const read = fs.readFileSync(path.join(configDir(), "credentials.json"), "utf8");
    strictEqual(read.includes("k-custom"), true);
    strictEqual(read.includes("k-alibaba"), true);
    strictEqual(resolveKey("my-custom").source, "none");
    strictEqual(clearKey("my-custom"), true);
    strictEqual(clearKey("my-custom"), false);
  });
  it("unknown provider ids resolve to no key", () => {
    strictEqual(resolveKey("nope-not-a-provider").source, "none");
  });
  it("credentials file is owner-only, and loose files are repaired", () => {
    if (process.platform === "win32") return; // stat-mode assertions are POSIX-only
    saveKey("nvidia", "k-perm");
    const p = path.join(configDir(), "credentials.json");
    strictEqual(fs.statSync(p).mode & 0o777, 0o600);
    fs.chmodSync(p, 0o644); // simulate a file left loose by an older version
    saveKey("mistral", "k-perm-2");
    strictEqual(fs.statSync(p).mode & 0o777, 0o600);
  });
  it("groq keys save/resolve/clear under their own field, preserving other providers", () => {
    const groqDir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-auth-groq-"));
    const prev = process.env[envKey];
    process.env[envKey] = groqDir;
    try {
      saveKey("groq", "k");
      saveKey("mistral", "k-mistral-kept");
      const r = resolveKey("groq");
      strictEqual(r.key, "k");
      strictEqual(r.source, "file");
      const stored = JSON.parse(
        fs.readFileSync(path.join(configDir(), "credentials.json"), "utf8")
      ) as Record<string, unknown>;
      strictEqual(stored["groqApiKey"], "k");
      strictEqual(clearKey("groq"), true);
      strictEqual(resolveKey("groq").source, "none");
      strictEqual(resolveKey("mistral").key, "k-mistral-kept");
      strictEqual(clearKey("groq"), false);
    } finally {
      if (prev === undefined) {
        delete process.env[envKey];
      } else {
        process.env[envKey] = prev;
      }
    }
  });
});