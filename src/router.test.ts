import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { classify, estimateCost, polishGate, resolveRoute, routeFor } from "./router.js";

describe("router", () => {
  it("classifies private signals first (safety wins)", () => {
    strictEqual(classify("fix typo in the password reset email").taskClass, "private");
    strictEqual(classify("rotate the api key in .env").taskClass, "private");
  });
  it("classifies polish signals", () => {
    strictEqual(classify("fix typo in README").taskClass, "polish");
    strictEqual(classify("format and lint the new module").taskClass, "polish");
  });
  it("defaults to implement", () => {
    const c = classify("add retry logic to the provider port");
    strictEqual(c.taskClass, "implement");
    ok(c.reason.length > 0);
  });
  it("routes implement → nvidia, polish → sensenova, private → error", () => {
    const impl = routeFor("implement");
    ok(!("error" in impl) && impl.provider === "nvidia");
    const pol = routeFor("polish");
    ok(!("error" in pol) && pol.provider === "sensenova");
    const priv = routeFor("private");
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
  it("auto-routes a polish prompt to sensenova", () => {
    const r = resolveRoute({ prompt: "fix typo in docs", defaultProvider: "nvidia", defaultModel: "moonshotai/kimi-k3" });
    ok(!("error" in r));
    if (!("error" in r)) {
      strictEqual(r.provider, "sensenova");
      strictEqual(r.taskClass, "polish");
      strictEqual(r.auto, true);
    }
  });
  it("refuses private prompts without an explicit provider", () => {
    const r = resolveRoute({ prompt: "read the production db password", defaultProvider: "nvidia", defaultModel: "moonshotai/kimi-k3" });
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
  it("polish gate passes only on priced <$0.05", () => {
    ok(polishGate(0).pass);
    ok(!polishGate(null).pass);
    ok(!polishGate(0.06).pass);
  });
});