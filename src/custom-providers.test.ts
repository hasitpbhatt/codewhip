import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  addCustomProvider,
  getProviderConfig,
  listAllProviderConfigs,
  loadCustomProviders,
  removeCustomProvider,
} from "./custom-providers.js";

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
});
