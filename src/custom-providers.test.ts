import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addCustomProvider,
  getProviderConfig,
  isLoopbackBaseUrl,
  listAllProviderConfigs,
  listLocalProviders,
  loadCustomProviders,
  removeCustomProvider,
} from "./custom-providers.js";
import { resolveKey, CONFIG_DIR_ENV } from "./auth.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-providers-"));

const BASE = {
  id: "my-gateway",
  baseUrl: "https://gateway.example.com/",
  defaultModel: "my-model",
  envVar: "MY_GATEWAY_API_KEY",
  keyUrl: "https://gateway.example.com/keys",
};

describe("custom-providers", () => {
  it("adds a valid provider with normalized fields", () => {
    const r = addCustomProvider({ ...BASE }, dir);
    strictEqual(r.ok, true);
    const cfg = getProviderConfig("my-gateway", dir);
    ok(cfg !== null);
    strictEqual(cfg?.baseUrl, "https://gateway.example.com");
    strictEqual(cfg?.chatPath, "/v1/chat/completions");
    strictEqual(cfg?.modelsPath, "/v1/models");
    strictEqual(cfg?.timeoutMs, 45000);
  });
  it("rejects duplicates and builtin collisions", () => {
    const dup = addCustomProvider({ ...BASE }, dir);
    strictEqual(dup.ok, false);
    const builtin = addCustomProvider({ ...BASE, id: "nvidia" }, dir);
    strictEqual(builtin.ok, false);
  });
  it("rejects invalid input without writing", () => {
    strictEqual(addCustomProvider({ ...BASE, id: "Bad_ID!" }, dir).ok, false);
    strictEqual(addCustomProvider({ ...BASE, id: "http-bad", baseUrl: "http://insecure.example.com" }, dir).ok, false);
    strictEqual(addCustomProvider({ ...BASE, id: "env-bad", envVar: "lowercase" }, dir).ok, false);
    strictEqual(addCustomProvider({ ...BASE, id: "timeout-bad", timeoutMs: 5 }, dir).ok, false);
    strictEqual(getProviderConfig("env-bad", dir), null);
  });
  it("lists builtins plus customs; customs resolve case-insensitively", () => {
    const all = listAllProviderConfigs(dir);
    ok(all.length >= 7);
    ok(all.some((c) => c.id === "llm7"));
    ok(all.some((c) => c.id === "my-gateway"));
    ok(getProviderConfig("MY-GATEWAY", dir) !== null);
  });
  it("removes customs but refuses builtins and unknowns", () => {
    strictEqual(removeCustomProvider("nvidia", dir).ok, false);
    strictEqual(removeCustomProvider("ghost", dir).ok, false);
    strictEqual(removeCustomProvider("my-gateway", dir).ok, true);
    strictEqual(getProviderConfig("my-gateway", dir), null);
  });
  it("corrupt files read as empty, never throw", () => {
    fs.writeFileSync(path.join(dir, "custom-providers.json"), "not json{{{", "utf8");
    strictEqual(Object.keys(loadCustomProviders(dir)).length, 0);
    strictEqual(getProviderConfig("my-gateway", dir), null);
    ok(listAllProviderConfigs(dir).length >= 6);
  });
  it("accepts http:// on loopback only — the local-runtime case (2026-09-14)", () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-local-"));
    strictEqual(addCustomProvider({ ...BASE, id: "ollama-local", baseUrl: "http://127.0.0.1:11434", envVar: "OLLAMA_LOCAL_API_KEY" }, local).ok, true);
    strictEqual(addCustomProvider({ ...BASE, id: "vllm", baseUrl: "http://localhost:8000", envVar: "VLLM_API_KEY" }, local).ok, true);
    strictEqual(addCustomProvider({ ...BASE, id: "lmstudio", baseUrl: "http://[::1]:1234", envVar: "LMSTUDIO_API_KEY" }, local).ok, true);
    // Non-loopback http stays refused: the provider key would cross the wire in clear.
    strictEqual(addCustomProvider({ ...BASE, id: "lan", baseUrl: "http://192.168.1.50:11434", envVar: "LAN_API_KEY" }, local).ok, false);
    strictEqual(addCustomProvider({ ...BASE, id: "any", baseUrl: "http://0.0.0.0:11434", envVar: "ANY_API_KEY" }, local).ok, false);
    strictEqual(addCustomProvider({ ...BASE, id: "pub", baseUrl: "http://insecure.example.com", envVar: "PUB_API_KEY" }, local).ok, false);
  });
  it("explains the remote/local id clash instead of just 'no registration needed'", () => {
    // "ollama" is the obvious id for a local runtime, but the remote ollama-cloud
    // builtin owns it. The old message implied the user had done something
    // unnecessary, when they actually need a different id.
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-clash-"));
    const r = addCustomProvider({ ...BASE, id: "ollama", baseUrl: "http://127.0.0.1:11434", envVar: "OLLAMA_API_KEY" }, local);
    strictEqual(r.ok, false);
    if (!r.ok) {
      ok(r.error.includes("remote"), r.error);
      ok(r.error.includes("ollama-local"), r.error);
    }
  });
  it("a loopback provider survives the save→load round trip (BOTH guards relaxed)", () => {
    // normalize() accepting it on write is not enough — if isValidRecord() still
    // demanded https, a registered local runtime would vanish on the next load.
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-roundtrip-"));
    strictEqual(addCustomProvider({ ...BASE, id: "ollama-local", baseUrl: "http://127.0.0.1:11434", envVar: "OLLAMA_LOCAL_API_KEY" }, local).ok, true);
    const cfg = getProviderConfig("ollama-local", local);
    ok(cfg !== null);
    strictEqual(cfg?.baseUrl, "http://127.0.0.1:11434");
    strictEqual(listLocalProviders(local).map((c) => c.id).join(","), "ollama-local");
  });
  it("a loopback runtime resolves a key with nothing stored (no credential needed)", () => {
    // index.ts:597 and serve.ts:342 both refuse an empty key, so without the
    // placeholder a local provider would resolve a route and then abort.
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-anon-"));
    addCustomProvider({ ...BASE, id: "ollama-local", baseUrl: "http://127.0.0.1:11434", envVar: "OLLAMA_LOCAL_ANON_API_KEY" }, local);
    const prev = process.env[CONFIG_DIR_ENV];
    process.env[CONFIG_DIR_ENV] = local;
    try {
      const r = resolveKey("ollama-local");
      strictEqual(r.source, "anonymous");
      strictEqual(r.key, "local");
    } finally {
      if (prev === undefined) delete process.env[CONFIG_DIR_ENV];
      else process.env[CONFIG_DIR_ENV] = prev;
    }
  });
  it("classifies loopback vs remote base URLs", () => {
    for (const u of ["http://127.0.0.1:11434", "http://127.0.0.5:1", "http://localhost:8000", "http://[::1]:1234"]) {
      strictEqual(isLoopbackBaseUrl(u), true, u);
    }
    for (const u of [
      "https://gateway.example.com",
      "http://gateway.example.com",
      "http://192.168.1.50:11434",
      "http://0.0.0.0:11434",
      "not-a-url",
    ]) {
      strictEqual(isLoopbackBaseUrl(u), false, u);
    }
  });
  it("listLocalProviders returns only loopback customs, never builtins", () => {
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-locals-"));
    addCustomProvider({ ...BASE, id: "remote-gw", baseUrl: "https://gateway.example.com", envVar: "REMOTE_GW_API_KEY" }, local);
    addCustomProvider({ ...BASE, id: "ollama-local", baseUrl: "http://127.0.0.1:11434", envVar: "OLLAMA_LOCAL_API_KEY" }, local);
    strictEqual(listLocalProviders(local).map((c) => c.id).join(","), "ollama-local");
  });
});
