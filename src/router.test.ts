import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { classify, estimateCost, isAutoEligible, isPolishRun, polishGate, polishRunCost, resolveRoute, routeFor } from "./router.js";
import { addCustomProvider, getProviderConfig } from "./custom-providers.js";
import { PROVIDERS } from "./provider.js";
import { CONFIG_DIR_ENV } from "./config-dir.js";

/**
 * Pinned empty config dir. `private` now consults registered local providers,
 * so without this these assertions would depend on whether the machine running
 * the suite happens to have one — a test that passes or fails by environment.
 */
const noLocalDir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-empty-"));

describe("router", () => {
  it("classifies private signals first (safety wins)", () => {
    strictEqual(classify("fix typo in the password reset email").taskClass, "private");
    strictEqual(classify("rotate the api key in .env").taskClass, "private");
  });
  it("classifies polish signals", () => {
    strictEqual(classify("fix typo in README").taskClass, "polish");
    strictEqual(classify("format and lint the new module").taskClass, "polish");
  });
  it("catches .env in the ordinary phrasings, not just word-glued (regression 2026-09-13)", () => {
    // `\b\.env\b` could never match before a literal "." — only "foo.env"
    // fired. These are the phrasings people actually type.
    strictEqual(classify("read the .env file and summarize it").taskClass, "private");
    strictEqual(classify(".env is missing, recreate it").taskClass, "private");
    strictEqual(classify("the .env file has a bad value").taskClass, "private");
    strictEqual(classify("check foo.env for stale vars").taskClass, "private");
  });
  it("catches PLURALS of the private keywords, not just the singular (regression 2026-09-14)", () => {
    // `\bcredential\b` cannot match "credentials", `\bsecret\b` cannot match
    // "secrets", `\bapi[-_ ]?key\b` cannot match "api keys" — so the whole
    // plural family, which is how people actually write, fell through to
    // `implement` and routed to a cloud free tier.
    for (const p of [
      "rotate the credentials for the staging database",
      "where are the secrets stored?",
      "list the api keys currently in use",
      "update the passwords in the config",
      "check the ssh private keys",
      "remove the hardcoded credentials",
      "the production database passwords rotated",
    ]) {
      strictEqual(classify(p).taskClass, "private", p);
    }
  });
  it("catches credential synonyms the original keyword list never had (2026-09-14)", () => {
    for (const p of [
      "the JWT signing key needs rotating",
      "add validation to the passphrase field",
      "the bearer token is hardcoded in the client",
      "encrypt the payload with the master key",
      "the database connection string is wrong",
      "the auth token expiry is too long",
      "read the AWS access key id",
      "the service account json is committed",
      "the kubeconfig for prod is world-readable",
      "the encryption key must not be logged",
      "the session cookie value leaks",
      "the recovery phrase is in the repo",
      "the wallet private key was pasted into a test",
    ]) {
      strictEqual(classify(p).taskClass, "private", p);
    }
  });
  it("still routes ordinary work as implement/polish (no classifier over-reach)", () => {
    // A false positive is not free — it refuses the run until --provider is
    // passed. The everyday phrasings must keep their real classes.
    strictEqual(classify("add retry logic to the provider port").taskClass, "implement");
    strictEqual(classify("refactor the provider registry").taskClass, "implement");
    strictEqual(classify("fix the typo in README").taskClass, "polish");
    strictEqual(classify("format and lint the new module").taskClass, "polish");
    strictEqual(classify("sort the results by key").taskClass, "implement");
    strictEqual(classify("raise the token budget to 500000").taskClass, "implement");
  });
  it("defaults to implement", () => {
    const c = classify("add retry logic to the provider port");
    strictEqual(c.taskClass, "implement");
    ok(c.reason.length > 0);
  });
  it("routes implement → nvidia, polish → kilo (priced $0), private → error", () => {
    const impl = routeFor("implement");
    ok(!("error" in impl) && impl.provider === "nvidia");
    const pol = routeFor("polish");
    ok(!("error" in pol) && pol.provider === "kilo");
    const priv = routeFor("private", noLocalDir);
    ok("error" in priv && (priv as { error: string }).error.includes("local provider"));
  });
  it("explicit --provider/--model always win (auto=false)", () => {
    const r = resolveRoute({
      prompt: "fix typo",
      provider: "mistral",
      model: "mistral-small-latest",
      defaultProvider: "nvidia",
      defaultModel: "moonshotai/kimi-k3",
    });
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "mistral");
      strictEqual(r.model, "mistral-small-latest");
      strictEqual(r.auto, false);
    }
  });
  it("auto-routes a polish prompt to the priced kilo hop (gate can pass)", () => {
    const r = resolveRoute({ prompt: "fix typo in docs", defaultProvider: "nvidia", defaultModel: "moonshotai/kimi-k3" });
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "kilo");
      strictEqual(r.taskClass, "polish");
      strictEqual(r.auto, true);
      // Priced $0 (verified free-tier entry) — the launch gate is passable.
      strictEqual(estimateCost(r.provider, r.model, 14977, 1449), 0);
      strictEqual(polishGate(estimateCost(r.provider, r.model, 14977, 1449)).pass, true);
    }
  });
  it("refuses private prompts without an explicit provider", () => {
    const r = resolveRoute({
      prompt: "read the production db password",
      defaultProvider: "nvidia",
      defaultModel: "moonshotai/kimi-k3",
      dir: noLocalDir,
    });
    ok("error" in r);
  });
  it("explicit provider consents to cloud routing for private prompts", () => {
    const r = resolveRoute({
      prompt: "read the production db password",
      provider: "mistral",
      defaultProvider: "nvidia",
      defaultModel: "moonshotai/kimi-k3",
    });
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "mistral");
      strictEqual(r.taskClass, "private");
    }
  });
  it("prices the known-free route, null otherwise", () => {
    strictEqual(estimateCost("nvidia", "moonshotai/kimi-k3", 10000, 5000), 0);
    strictEqual(estimateCost("sensenova", "sensenova-6.8-flash-lite", 10000, 5000), null);
  });
  it("stops pricing cerebras $0 once its free tier required a card (rot repair 2026-09-13)", () => {
    // Regression: the $0 sticker was a fiction after Cerebras moved to
    // card-bound credits. Unpriced is the honest answer.
    strictEqual(estimateCost("cerebras", "qwen-3-coder-480b", 1000, 1000), null);
  });
  it("prices every free-chain default $0 (not null)", () => {
    const pairs: Array<[string, string]> = [
      ["groq", "openai/gpt-oss-120b"],
      ["opencode", "mimo-v2.5-free"],
      ["kilo", "cohere/north-mini-code:free"],
      ["openrouter", "nvidia/nemotron-3-super-120b-a12b:free"],
      ["gemini", "gemini-2.5-flash"],
      ["zai", "glm-5.3-flash"],
      ["empero", "glm-5.3-flash"],
    ];
    for (const [provider, model] of pairs) {
      strictEqual(estimateCost(provider, model, 1000, 1000), 0, `${provider}:${model}`);
    }
  });
  it("polish gate passes on a $0 free-chain route; unpriced pairs stay null", () => {
    const cost = estimateCost("groq", "openai/gpt-oss-120b", 1000, 1000);
    strictEqual(cost, 0);
    ok(polishGate(cost).pass);
    strictEqual(estimateCost("groq", "some-paid-model", 1000, 1000), null);
  });
  it("prices a loopback runtime $0, not 'untracked' (there is no console to check)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-cost-"));
    addCustomProvider({ id: "local-gw", baseUrl: "http://127.0.0.1:11434", defaultModel: "default", envVar: "LOCAL_GW_API_KEY" }, dir);
    addCustomProvider({ id: "remote-gw", baseUrl: "https://gateway.example.com", defaultModel: "m", envVar: "REMOTE_GW_API_KEY" }, dir);
    const prev = process.env[CONFIG_DIR_ENV];
    process.env[CONFIG_DIR_ENV] = dir;
    try {
      strictEqual(estimateCost("local-gw", "default", 1000, 1000), 0);
      // A remote custom provider stays honestly untracked — we cannot know.
      strictEqual(estimateCost("remote-gw", "m", 1000, 1000), null);
    } finally {
      if (prev === undefined) delete process.env[CONFIG_DIR_ENV];
      else process.env[CONFIG_DIR_ENV] = prev;
    }
  });
  it("polish gate passes only on priced <$0.05", () => {
    ok(polishGate(0).pass);
    ok(!polishGate(null).pass);
    ok(!polishGate(0.06).pass);
  });
  it("isPolishRun prefers task_class, falls back to routing-era markers", () => {
    const base = { model: "m", usage: { prompt: 1, completion: 1 } } as const;
    ok(isPolishRun({ ...base, task_class: "polish" }));
    ok(!isPolishRun({ ...base, task_class: "implement" }));
    // Legacy: sensenova era bare id, kilo era bare id and buckets.
    ok(isPolishRun({ ...base, model: "sensenova-6.8-flash-lite" }));
    ok(isPolishRun({ ...base, model: "cohere/north-mini-code:free" }));
    ok(isPolishRun({ ...base, usageByModel: [{ label: "kilo", model: "cohere/north-mini-code:free", prompt: 1, completion: 1 }] }));
    ok(!isPolishRun({ ...base, model: "moonshotai/kimi-k3" }));
  });
  it("polishRunCost totals buckets; untracked legs and bare ids stay null", () => {
    strictEqual(
      polishRunCost({ model: "cohere/north-mini-code:free", usage: { prompt: 14977, completion: 1449 }, usageByModel: [{ label: "kilo", model: "cohere/north-mini-code:free", prompt: 14977, completion: 1449 }] }),
      0
    );
    // One untracked leg poisons the total — never partial-fiction.
    strictEqual(
      polishRunCost({ model: "m", usage: { prompt: 1, completion: 1 }, usageByModel: [{ label: "kilo", model: "cohere/north-mini-code:free", prompt: 1, completion: 1 }, { label: "sensenova", model: "sensenova-6.8-flash-lite", prompt: 1, completion: 1 }] }),
      null
    );
    // No buckets: first-colon split prices "prov:model", bare ids stay null.
    strictEqual(polishRunCost({ model: "groq:openai/gpt-oss-120b", usage: { prompt: 1000, completion: 1000 } }), 0);
    strictEqual(polishRunCost({ model: "cohere/north-mini-code:free", usage: { prompt: 1, completion: 1 } }), null);
  });
  it("routes private → the one registered local runtime, loopback only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-one-"));
    const added = addCustomProvider(
      { id: "ollama-local", baseUrl: "http://127.0.0.1:11434", defaultModel: "qwen3:35b", envVar: "OLLAMA_LOCAL_API_KEY" },
      dir
    );
    strictEqual(added.ok, true);
    const r = routeFor("private", dir);
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "ollama-local");
      strictEqual(r.model, "qwen3:35b");
      ok(r.note.includes("loopback"));
    }
  });
  it("private stays a refusal when several local runtimes are registered (ambiguous, not a guess)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-many-"));
    strictEqual(
      addCustomProvider({ id: "ollama-a", baseUrl: "http://127.0.0.1:11434", defaultModel: "m", envVar: "OLLAMA_A_API_KEY" }, dir).ok,
      true
    );
    strictEqual(
      addCustomProvider({ id: "vllm-b", baseUrl: "http://localhost:8000", defaultModel: "m", envVar: "VLLM_B_API_KEY" }, dir).ok,
      true
    );
    const r = routeFor("private", dir);
    ok("error" in r && (r as { error: string }).error.includes("pass --provider"));
  });
  it("a registered remote https provider is NOT a private destination", () => {
    // Only loopback http counts as local. A remote gateway — even a legitimate
    // one — must never be auto-selected for a secret-bearing prompt.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-remote-"));
    addCustomProvider({ id: "remote-gw", baseUrl: "https://gateway.example.com", defaultModel: "m", envVar: "REMOTE_GW_API_KEY" }, dir);
    ok("error" in routeFor("private", dir));
  });
  it("auto-routes a private prompt to local once one is registered", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-auto-"));
    addCustomProvider({ id: "ollama-local", baseUrl: "http://127.0.0.1:11434", defaultModel: "qwen3:35b", envVar: "OLLAMA_LOCAL_API_KEY" }, dir);
    const r = resolveRoute({ prompt: "read the production db password", defaultProvider: "nvidia", defaultModel: "moonshotai/kimi-k3", dir });
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "ollama-local");
      strictEqual(r.taskClass, "private");
      strictEqual(r.auto, true);
    }
  });
  it("an explicit --provider still wins over the local runtime", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-router-override-"));
    addCustomProvider({ id: "ollama-local", baseUrl: "http://127.0.0.1:11434", defaultModel: "qwen3:35b", envVar: "OLLAMA_LOCAL_API_KEY" }, dir);
    const r = resolveRoute({
      prompt: "read the production db password",
      provider: "mistral",
      defaultProvider: "nvidia",
      defaultModel: "moonshotai/kimi-k3",
      dir,
    });
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "mistral");
      strictEqual(r.taskClass, "private");
    }
  });
  it("auto eligibility: anonymous tiers yes, env-keyed untracked routes no, opt-in flips it", () => {
    // llm7 is anonymous in a clean env — free by construction, always eligible.
    const llm7 = getProviderConfig("llm7");
    ok(llm7 !== null);
    const prevLlm7 = process.env[llm7.envVar];
    delete process.env[llm7.envVar];
    // sensenova is the paid-key case: untracked cost, no anonymous fallback.
    const cfg = getProviderConfig("sensenova");
    ok(cfg !== null);
    const prevKey = process.env[cfg.envVar];
    const prevOpt = process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED;
    delete process.env[cfg.envVar];
    delete process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED;
    try {
      ok(isAutoEligible("llm7", PROVIDERS.llm7.defaultModel));
      process.env[cfg.envVar] = "paid-key-for-test";
      strictEqual(isAutoEligible("sensenova", cfg.defaultModel), false);
      process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED = "1";
      strictEqual(isAutoEligible("sensenova", cfg.defaultModel), true);
    } finally {
      if (prevLlm7 === undefined) delete process.env[llm7.envVar];
      else process.env[llm7.envVar] = prevLlm7;
      if (prevKey === undefined) delete process.env[cfg.envVar];
      else process.env[cfg.envVar] = prevKey;
      if (prevOpt === undefined) delete process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED;
      else process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED = prevOpt;
    }
  });
});