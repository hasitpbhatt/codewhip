import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FREE_CHAIN, freeChainIds, freeChainCandidates, listFreeProviders } from "./free-providers.js";
import { PROVIDERS, PROVIDER_IDS } from "./provider.js";
import { getProviderConfig } from "./custom-providers.js";

const CHAIN_ORDER = "kilo,opencode,empero,groq,cerebras,openrouter,gemini,zai,nvidia,mistral,llm7";

// Isolate key resolution from the developer's real config dir: candidates
// tests must see only env vars + anonymous keys, never stored files.
process.env.CODEWHIP_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-free-"));
for (const id of PROVIDER_IDS) {
  delete process.env[`${id.toUpperCase()}_API_KEY`];
}

describe("free-providers", () => {
  it("FREE_CHAIN hop order is fixed (keyless tiers first, llm7 keyless floor last)", () => {
    strictEqual(FREE_CHAIN.map((e) => e.id).join(","), CHAIN_ORDER);
  });
  it("exactly the verified keyless set is keyNeeded:'no'; every entry resolves to a registered provider", () => {
    const keyless = FREE_CHAIN.filter((e) => e.keyNeeded === "no").map((e) => e.id);
    strictEqual(keyless.join(","), "kilo,opencode,empero,llm7");
    for (const e of FREE_CHAIN) {
      ok(getProviderConfig(e.id) !== null, e.id);
      ok(e.freeOffer.length > 0 && e.limits.length > 0, e.id);
    }
  });
  it("every keyless entry resolves a key with no env and no stored file (anonymous)", () => {
    const prevEnv: string[] = [];
    for (const id of PROVIDER_IDS) {
      const name = `${id.toUpperCase()}_API_KEY`;
      if (process.env[name] !== undefined) {
        prevEnv.push(name);
        delete process.env[name];
      }
    }
    try {
      for (const id of ["kilo", "opencode", "empero", "llm7"] as const) {
        const r = freeChainCandidates().find((c) => c === id);
        ok(r !== undefined, `${id} should be a keyless candidate`);
      }
    } finally {
      for (const name of prevEnv) {
        process.env[name] = "1";
      }
    }
  });
  it("keyed entries stay out of the candidates until their env var is set", () => {
    const prevEnv: string[] = [];
    for (const id of PROVIDER_IDS) {
      const name = `${id.toUpperCase()}_API_KEY`;
      if (process.env[name] !== undefined) {
        prevEnv.push(name);
        delete process.env[name];
      }
    }
    try {
      ok(!freeChainCandidates().includes("groq"), "groq needs a key");
      process.env.GROQ_API_KEY = "test-key";
      const withKey = freeChainCandidates();
      ok(withKey.includes("groq"), "groq joins once keyed");
      // Hop order preserved: groq sits in catalog position, llm7 stays the floor.
      const i = withKey.indexOf("groq");
      strictEqual(withKey[i - 1], "empero");
      strictEqual(withKey[i + 1], "llm7");
    } finally {
      delete process.env.GROQ_API_KEY;
      for (const name of prevEnv) {
        process.env[name] = "1";
      }
    }
  });
  it("chain entries match their ProviderConfig rows (endpoints verified 2026-09-11)", () => {
    const expectedBase = new Map<string, string>([
      ["opencode", "https://opencode.ai"],
      ["kilo", "https://api.kilo.ai"],
      ["groq", "https://api.groq.com"],
      ["cerebras", "https://api.cerebras.ai"],
      ["openrouter", "https://openrouter.ai"],
      ["gemini", "https://generativelanguage.googleapis.com"],
      ["zai", "https://api.z.ai"],
      ["empero", "https://free.empero.org"],
    ]);
    for (const e of FREE_CHAIN) {
      const expected = expectedBase.get(e.id);
      if (expected !== undefined) {
        strictEqual(PROVIDERS[e.id].baseUrl, expected, e.id);
      }
      const cfg = getProviderConfig(e.id);
      ok(cfg !== null, e.id);
      strictEqual(cfg?.baseUrl, PROVIDERS[e.id].baseUrl, e.id);
    }
  });
  it("listFreeProviders() joins the chain with the registry columns", () => {
    const rows = listFreeProviders();
    strictEqual(rows.length, 11);
    for (const r of rows) {
      const cfg = PROVIDERS[r.id];
      strictEqual(r.envVar, cfg.envVar, r.id);
      strictEqual(r.keyUrl, cfg.keyUrl, r.id);
      strictEqual(r.brand, cfg.brand, r.id);
    }
    // Presentation order (cmdFree in index.ts) sorts keyless first — the
    // chain data must support it: the keyless rows head the chain.
    const keylessFirst = [...rows.filter((r) => r.keyNeeded === "no"), ...rows.filter((r) => r.keyNeeded === "free-key")];
    strictEqual(keylessFirst[0]?.id, "kilo");
    strictEqual(keylessFirst[3]?.id, "llm7");
  });
  it("freeChainIds() is a pure view of FREE_CHAIN", () => {
    const ids = freeChainIds();
    strictEqual(ids.length, FREE_CHAIN.length);
    strictEqual(ids.join(","), CHAIN_ORDER);
  });
});
