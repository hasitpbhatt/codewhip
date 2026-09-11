import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { chatUrlFor, modelsUrlFor, makePort, makePortForConfig, parseProviderId, isBuiltinProviderId, PROVIDERS, PROVIDER_IDS, DEFAULT_CHAT_TIMEOUT_MS } from "./provider.js";
import { parseRetryAfter } from "./provider.js";

describe("provider", () => {
  it("parseRetryAfter parses seconds", () => {
    strictEqual(parseRetryAfter("5"), 5000);
  });
  it("parseRetryAfter caps at 60s", () => {
    strictEqual(parseRetryAfter("120"), 60000);
  });
  it("parseRetryAfter parses HTTP-date", () => {
    const future = new Date(Date.now() + 30000).toUTCString();
    const r = parseRetryAfter(future) ?? 0;
    strictEqual(r > 0, true);
    strictEqual(r <= 60000, true);
  });
  it("parseRetryAfter returns undefined when absent", () => {
    strictEqual(parseRetryAfter(null), undefined);
  });
  it("parseRetryAfter returns undefined for past dates", () => {
    strictEqual(parseRetryAfter("Mon, 01 Jan 2000 00:00:00 GMT"), undefined);
  });
  it("parseRetryAfter returns undefined for malformed", () => {
    strictEqual(parseRetryAfter("not-a-date"), undefined);
  });
  it("chat URL for sensenova matches the user-specified endpoint", () => {
    strictEqual(chatUrlFor(PROVIDERS.sensenova), "https://token.sensenova.ai/v1/chat/completions");
  });
  it("llm7 rides the documented OpenAI-compatible endpoint with anonymous fallback", () => {
    strictEqual(chatUrlFor(PROVIDERS.llm7), "https://api.llm7.io/v1/chat/completions");
    strictEqual(modelsUrlFor(PROVIDERS.llm7), "https://api.llm7.io/v1/models");
    strictEqual(PROVIDERS.llm7.defaultModel, "default");
    strictEqual(PROVIDERS.llm7.envVar, "LLM7_API_KEY");
    strictEqual(PROVIDERS.llm7.anonymousKey, "unused");
  });
  it("bai rides the documented gateway endpoint (key required)", () => {
    strictEqual(chatUrlFor(PROVIDERS.bai), "https://api.b.ai/v1/chat/completions");
    strictEqual(modelsUrlFor(PROVIDERS.bai), "https://api.b.ai/v1/models");
    strictEqual(PROVIDERS.bai.defaultModel, "GPT-5 Nano");
    strictEqual(PROVIDERS.bai.envVar, "BAI_API_KEY");
    strictEqual(PROVIDERS.bai.anonymousKey, undefined);
  });
  it("fabryka rides the documented router endpoint (key required)", () => {
    strictEqual(chatUrlFor(PROVIDERS.fabryka), "https://router.fabryka.ai/v1/chat/completions");
    strictEqual(modelsUrlFor(PROVIDERS.fabryka), "https://router.fabryka.ai/v1/models");
    strictEqual(PROVIDERS.fabryka.defaultModel, "qwen3.6-35b-a3b");
    strictEqual(PROVIDERS.fabryka.envVar, "FABRYKA_API_KEY");
    strictEqual(PROVIDERS.fabryka.anonymousKey, undefined);
  });
  it("makePortForConfig adapts any config; makePort refuses unknown ids without throwing", async () => {
    const port = makePortForConfig({ ...PROVIDERS.llm7, id: "llm7-clone" }, "test-key");
    ok(typeof port === "function", "custom config port");
    const bad = makePort("nope-not-a-provider", "test-key");
    const res = await bad({ model: "m", messages: [], tools: [] });
    strictEqual(res.ok, false);
    ok(!isBuiltinProviderId("nope-not-a-provider"));
    ok(isBuiltinProviderId("llm7"));
  });
  it("alibaba chat + models URLs are compatible-mode paths", () => {
    strictEqual(chatUrlFor(PROVIDERS.alibaba), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    strictEqual(modelsUrlFor(PROVIDERS.alibaba), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models");
  });
  it("nvidia and mistral preserve their existing endpoints", () => {
    strictEqual(chatUrlFor(PROVIDERS.nvidia), "https://integrate.api.nvidia.com/v1/chat/completions");
    strictEqual(chatUrlFor(PROVIDERS.mistral), "https://api.mistral.ai/v1/chat/completions");
  });
  it("every registered provider builds a valid port and config", () => {
    for (const id of PROVIDER_IDS) {
      const cfg = PROVIDERS[id];
      ok(cfg.baseUrl.startsWith("https://"), id);
      ok(cfg.chatPath.startsWith("/"), id);
      ok(cfg.modelsPath.startsWith("/"), id);
      ok(cfg.defaultModel.length > 0, id);
      ok(cfg.envVar.endsWith("_API_KEY"), id);
      const port = makePort(id, "test-key");
      ok(typeof port === "function", id);
    }
    strictEqual(PROVIDER_IDS.length, 8);
    strictEqual(parseProviderId("sensenova"), "sensenova");
    strictEqual(parseProviderId("alibaba"), "alibaba");
    strictEqual(parseProviderId("llm7"), "llm7");
    strictEqual(parseProviderId("tokenharbor"), "tokenharbor");
    strictEqual(parseProviderId("bai"), "bai");
    strictEqual(parseProviderId("fabryka"), "fabryka");
    strictEqual(parseProviderId("bogus"), null);
    strictEqual(parseProviderId(undefined), null);
  });
  it("all builtins share the single chat-call default (no per-provider constant farm)", () => {
    strictEqual(DEFAULT_CHAT_TIMEOUT_MS, 120000);
    for (const id of PROVIDER_IDS) {
      strictEqual(PROVIDERS[id].timeoutMs, DEFAULT_CHAT_TIMEOUT_MS, id);
    }
  });
  it("aborted calls report retryable timeout (rotation path, not terminal other)", async () => {    const realFetch = globalThis.fetch;
    const hangingFetch = (): Promise<Response> =>
      Promise.reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
    globalThis.fetch = hangingFetch as typeof fetch;
    try {
      const port = makePort("nvidia", "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "timeout");
      ok(res.error.includes("timed out after 120000ms"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("makePortForConfig honors the per-call timeout override (--timeout-ms plumbing)", async () => {
    const realFetch = globalThis.fetch;
    // Hanging but signal-cooperative stub (like real fetch): the port's own
    // timer must drive the abort, so the stub has to listen for it.
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("timeout"), { name: "AbortError" }));
        });
      })) as typeof fetch;
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key", 50);
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "timeout");
      ok(res.error.includes("timed out after 50ms"));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
