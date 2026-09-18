import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { chatUrlFor, modelsUrlFor, makePort, makePortForConfig, parseProviderId, isBuiltinProviderId, PROVIDERS, PROVIDER_IDS, DEFAULT_CHAT_TIMEOUT_MS, setStreamingEnabled, unresolvedBaseUrlVars } from "./provider.js";
import { parseRetryAfter } from "./provider.js";

/** Build a Response whose body is the given SSE text, one chunk per string. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * Response that emits a keep-alive comment then goes silent forever, and —
 * like real fetch — errors its body when the request signal aborts, so a
 * pending `reader.read()` rejects instead of hanging.
 */
function hangingSseResponse(signal?: AbortSignal): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": keep-alive\n\n"));
      signal?.addEventListener(
        "abort",
        () => {
          try {
            controller.error(new Error("The operation was aborted"));
          } catch {
            /* already closed */
          }
        },
        { once: true },
      );
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function stubFetchReturning(make: (call: number) => Response | Promise<Response>): { restore: () => void; calls: Array<{ stream: boolean }> } {
  const real = globalThis.fetch;
  const calls: Array<{ stream: boolean }> = [];
  let n = 0;
  globalThis.fetch = ((_url: string, init?: { body?: unknown }) => {
    let stream = false;
    try {
      stream = (JSON.parse(String(init?.body)) as { stream?: boolean }).stream === true;
    } catch { /* leave false */ }
    calls.push({ stream });
    n += 1;
    return Promise.resolve(make(n));
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = real; }, calls };
}

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
  it("free aggregators ride their verified endpoints (origin + path shape)", () => {
    const expected: Array<[string, string, string]> = [
      ["opencode", "https://opencode.ai/zen/v1/chat/completions", "https://opencode.ai/zen/v1/models"],
      ["kilo", "https://api.kilo.ai/api/gateway/v1/chat/completions", "https://api.kilo.ai/api/gateway/v1/models"],
      ["groq", "https://api.groq.com/openai/v1/chat/completions", "https://api.groq.com/openai/v1/models"],
      ["cerebras", "https://api.cerebras.ai/v1/chat/completions", "https://api.cerebras.ai/v1/models"],
      ["openrouter", "https://openrouter.ai/api/v1/chat/completions", "https://openrouter.ai/api/v1/models"],
      ["gemini", "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", "https://generativelanguage.googleapis.com/v1beta/openai/models"],
      ["zai", "https://api.z.ai/api/paas/v4/chat/completions", "https://api.z.ai/api/paas/v4/models"],
      ["empero", "https://free.empero.org/v1/chat/completions", "https://free.empero.org/v1/models"],
    ];
    for (const [id, chat, models] of expected) {
      strictEqual(chatUrlFor(PROVIDERS[id as keyof typeof PROVIDERS]), chat, id);
      strictEqual(modelsUrlFor(PROVIDERS[id as keyof typeof PROVIDERS]), models, id);
    }
  });
  it("keyless free tiers carry their verified anonymous keys; opencode carries its identity headers", () => {
    strictEqual(PROVIDERS.kilo.anonymousKey, "anonymous");
    strictEqual(PROVIDERS.opencode.anonymousKey, "public");
    strictEqual(PROVIDERS.empero.anonymousKey, "free");
    strictEqual(PROVIDERS.pollinations.anonymousKey, "unused");
    ok(PROVIDERS.opencode.headers?.["x-opencode-session"]?.startsWith("ses-"), "session header present");
    strictEqual(PROVIDERS.opencode.headers?.["User-Agent"], "opencode/1.0.0");
    // The keyed free tiers must not fake keyless access.
    strictEqual(PROVIDERS.groq.anonymousKey, undefined);
    strictEqual(PROVIDERS.cerebras.anonymousKey, undefined);
    strictEqual(PROVIDERS.openrouter.anonymousKey, undefined);
    strictEqual(PROVIDERS.gemini.anonymousKey, undefined);
    strictEqual(PROVIDERS.zai.anonymousKey, undefined);
  });
  it("free-tier candidates harvested 2026-09-13 ride their verified endpoints", () => {
    const expected: Array<[string, string, string]> = [
      ["modelscope", "https://api-inference.modelscope.cn/v1/chat/completions", "https://api-inference.modelscope.cn/v1/models"],
      ["ovhcloud", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models"],
      ["ollama", "https://ollama.com/v1/chat/completions", "https://ollama.com/v1/models"],
      ["cohere", "https://api.cohere.com/compatibility/v1/chat/completions", "https://api.cohere.com/compatibility/v1/models"],
      ["siliconflow", "https://api.siliconflow.cn/v1/chat/completions", "https://api.siliconflow.cn/v1/models"],
      ["aionlabs", "https://api.aionlabs.ai/v1/chat/completions", "https://api.aionlabs.ai/v1/models"],
      ["agnes", "https://apihub.agnes-ai.com/v1/chat/completions", "https://apihub.agnes-ai.com/v1/models"],
      ["requesty", "https://router.requesty.ai/v1/chat/completions", "https://router.requesty.ai/v1/models"],
      ["inference", "https://api.inference.net/v1/chat/completions", "https://api.inference.net/v1/models"],
      ["hetzner", "https://inference.hetzner.com/api/v1/chat/completions", "https://inference.hetzner.com/api/v1/models"],
      ["venice", "https://api.venice.ai/api/v1/chat/completions", "https://api.venice.ai/api/v1/models"],
      ["scaleway", "https://api.scaleway.ai/v1/chat/completions", "https://api.scaleway.ai/v1/models"],
      ["friendli", "https://inference.friendli.ai/v1/chat/completions", "https://inference.friendli.ai/v1/models"],
      ["nscale", "https://inference.api.nscale.com/v1/chat/completions", "https://inference.api.nscale.com/v1/models"],
      ["nebius", "https://api.tokenfactory.nebius.com/v1/chat/completions", "https://api.tokenfactory.nebius.com/v1/models"],
      ["ai21", "https://api.ai21.com/studio/v1/chat/completions", "https://api.ai21.com/studio/v1/models"],
      ["coze", "https://api.coze.com/v1/chat/completions", "https://api.coze.com/v1/models"],
    ];
    for (const [id, chat, models] of expected) {
      strictEqual(chatUrlFor(PROVIDERS[id as keyof typeof PROVIDERS]), chat, id);
      strictEqual(modelsUrlFor(PROVIDERS[id as keyof typeof PROVIDERS]), models, id);
    }
    // None of the new batch may fake keyless access: they are keyed hops only.
    for (const id of ["cloudflare", "modelscope", "ovhcloud", "ollama", "cohere", "siliconflow", "aionlabs", "agnes", "requesty", "inference", "hetzner", "venice", "scaleway", "friendli", "nscale", "nebius", "ai21", "coze"] as const) {
      strictEqual(PROVIDERS[id].anonymousKey, undefined, id);
    }
  });
  it("account-scoped base urls resolve {ENV} placeholders and refuse to run unset", async () => {
    strictEqual(PROVIDERS.cloudflare.baseUrl, "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai");
    const prev = process.env.CLOUDFLARE_ACCOUNT_ID;
    try {
      delete process.env.CLOUDFLARE_ACCOUNT_ID;
      strictEqual(unresolvedBaseUrlVars(PROVIDERS.cloudflare.baseUrl).join(","), "CLOUDFLARE_ACCOUNT_ID");
      // A ready provider reports no missing vars.
      strictEqual(unresolvedBaseUrlVars(PROVIDERS.nvidia.baseUrl).length, 0);
      // Unset placeholder collapses to an empty segment rather than throwing…
      strictEqual(chatUrlFor(PROVIDERS.cloudflare), "https://api.cloudflare.com/client/v4/accounts//ai/v1/chat/completions");
      // …but the port refuses the call with a pointed error, not a 404.
      const port = makePort("cloudflare", "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      ok(res.error.includes("CLOUDFLARE_ACCOUNT_ID"), res.error);
      // With the id set, the template resolves and the call is allowed through.
      process.env.CLOUDFLARE_ACCOUNT_ID = "acct-123";
      strictEqual(chatUrlFor(PROVIDERS.cloudflare), "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/v1/chat/completions");
      strictEqual(unresolvedBaseUrlVars(PROVIDERS.cloudflare.baseUrl).length, 0);
    } finally {
      if (prev === undefined) {
        delete process.env.CLOUDFLARE_ACCOUNT_ID;
      } else {
        process.env.CLOUDFLARE_ACCOUNT_ID = prev;
      }
    }
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
    strictEqual(PROVIDER_IDS.length, 95);
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
    // Community gateways get a shorter timeout (8s) — they're volatile and
    // we'd rather fail fast than hang. Every other builtin must use the default.
    const shortTimeout = new Set(["zukijourney", "nagaai", "zanityai", "kimetsu", "navyapi", "mnn", "hcap", "voltai", "electronhub", "xkiro", "gonkarouter", "bazaarlink", "seldon", "cavoti", "getunikey", "bynara", "atria", "onerouter", "xpiki", "suyu", "voapi", "nio", "mkeai", "apiyi"]);
    for (const id of PROVIDER_IDS) {
      if (shortTimeout.has(id)) {
        strictEqual(PROVIDERS[id].timeoutMs, 8000, `${id} should use the community-gateway timeout`);
      } else {
        strictEqual(PROVIDERS[id].timeoutMs, DEFAULT_CHAT_TIMEOUT_MS, id);
      }
    }
  });
  it("1min rides its own port and every other builtin rides the openai one", () => {
    // The discriminator is what routes makePortForConfig; if it silently
    // reverted to undefined, 1min would be sent an OpenAI body it cannot read.
    strictEqual(PROVIDERS["1min"].port, "onemin");
    strictEqual(makePort("1min", "test-key") !== undefined, true);
    for (const id of PROVIDER_IDS) {
      if (id === "1min") continue;
      strictEqual(PROVIDERS[id].port, undefined, id);
    }
    // A POSIX shell cannot export an identifier starting with a digit, so the
    // env var must not be derived from the id here.
    strictEqual(PROVIDERS["1min"].envVar, "ONEMIN_API_KEY");
    strictEqual(parseProviderId("1min"), "1min");
  });
  it("timer expiry is classified by the timer, not by the rejection's name", async () => {
    const realFetch = globalThis.fetch;
    // Regression: aborting with a custom reason makes fetch reject with that
    // reason object (name "Error"), and an aborted body read rejects with a
    // plain Error too. A rejection named neither TimeoutError nor AbortError
    // must still land on the rotation path — only the port's own timer flag
    // can tell it apart from a network failure.
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        const s = init?.signal;
        if (s === undefined) {
          reject(new Error("stub: no signal"));
          return;
        }
        const fail = (): void => reject(new Error("The operation was aborted"));
        if (s.aborted) {
          fail();
          return;
        }
        s.addEventListener("abort", fail, { once: true });
      })) as typeof fetch;
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key", 50);
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "timeout");
      ok(res.error.includes("timed out after 50ms"), res.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("a non-timeout transport rejection stays a non-retryable network error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as typeof fetch;
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key", 5000);
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "other");
      ok(res.error.includes("network error on"), res.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("an upstream 5xx (and 408) is typed `server` so the chain can rotate past it", async () => {
    // Regression 2026-09-14: 5xx used to fall into the terminal `other` class,
    // so a provider in a maintenance window (empero answered 503) killed a
    // `--free` run instead of letting it hop to the next free tier.
    const realFetch = globalThis.fetch;
    for (const status of [500, 502, 503, 504, 408]) {
      globalThis.fetch = (() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: { message: "maintenance" } }), {
            status,
            headers: { "content-type": "application/json" },
          })
        )) as typeof fetch;
      try {
        const port = makePortForConfig(PROVIDERS.empero, "test-key", 5000);
        const res = await port({ model: "m", messages: [], tools: [] });
        strictEqual(res.ok, false, `HTTP ${status} should fail`);
        if (res.ok) continue;
        strictEqual(res.retryable, "server", `HTTP ${status} must be rotatable`);
      } finally {
        globalThis.fetch = realFetch;
      }
    }
  });
  it("a 4xx stays terminal (`other`) — a bad request repeats wherever it is sent", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "unknown model" } }), {
          status: 404,
          headers: { "content-type": "application/json" },
        })
      )) as typeof fetch;
    try {
      const port = makePortForConfig(PROVIDERS.empero, "test-key", 5000);
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "other");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("a caller abort is reported as cancelled, never as a provider timeout", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key", 60000);
      const ctrl = new AbortController();
      const pending = port({ model: "m", messages: [], tools: [], signal: ctrl.signal });
      ctrl.abort();
      const res = await pending;
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.error, "cancelled");
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("an already-aborted caller signal short-circuits before any request", async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.reject(new Error("should not be called"));
    }) as typeof fetch;
    try {
      const port = makePort("nvidia", "test-key");
      const ctrl = new AbortController();
      ctrl.abort();
      const res = await port({ model: "m", messages: [], tools: [], signal: ctrl.signal });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.error, "cancelled");
      strictEqual(calls, 0);
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
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      })) as typeof fetch;
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key", 50);
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "timeout");
      ok(res.error.includes("timed out after 50ms"), res.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("streams content deltas into one message and prefers the usage block", async () => {
    const stub = stubFetchReturning(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":", world"}}]}\n\n',
        'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n',
        "data: [DONE]\n\n",
      ]));
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "Hello, world");
      strictEqual(res.toolCalls.length, 0);
      strictEqual(res.promptTokens, 11);
      strictEqual(res.completionTokens, 7);
      strictEqual(res.usageEstimated, false);
      strictEqual(stub.calls[0]?.stream, true);
    } finally {
      stub.restore();
    }
  });
  it("survives an explicit usage:null chunk (pollinations anonymous budget reply)", async () => {
    // Live-observed 2026-09-16: pollinations' anonymous tier emits
    // `"usage": null` on the budget-exhausted response. The fold must not
    // dereference it — null.usage crashed into a mislabeled network error.
    const stub = stubFetchReturning(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"budget drained"}}],"usage":null}\n\n',
        "data: [DONE]\n\n",
      ]));
    try {
      const port = makePortForConfig(PROVIDERS.pollinations, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "budget drained");
      // No usable usage block: counts are estimates and say so.
      strictEqual(res.usageEstimated, true);
    } finally {
      stub.restore();
    }
  });
  it("reassembles a tool call whose arguments arrive split across chunks", async () => {
    const stub = stubFetchReturning(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"f.txt\\"}"}}]}}]}\n\n',
        "data: [DONE]\n\n",
      ]));
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, null);
      strictEqual(res.toolCalls.length, 1);
      strictEqual(res.toolCalls[0]?.name, "read");
      strictEqual(res.toolCalls[0]?.id, "call_a");
      strictEqual(res.toolCalls[0]?.argsJson, '{"path":"f.txt"}');
      // No usage block: counts are estimates and say so.
      strictEqual(res.usageEstimated, true);
      ok(res.promptTokens > 0 && res.completionTokens > 0);
    } finally {
      stub.restore();
    }
  });
  it("survives a split across TCP-style chunk boundaries and malformed events", async () => {
    const stub = stubFetchReturning(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"cont', // line cut mid-JSON
        'ent":"ok"}}]}\n\n',
        "garbage line without a data prefix\n",
        ": heartbeat\n\n",
        "data: [DONE]\n\n",
      ]));
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "ok");
    } finally {
      stub.restore();
    }
  });
  it("accepts a gateway that sends whole messages instead of deltas", async () => {
    const stub = stubFetchReturning(() =>
      sseResponse([
        'data: {"choices":[{"message":{"content":"whole"}}]}\n\n',
        "data: [DONE]\n\n",
      ]));
    try {
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "whole");
    } finally {
      stub.restore();
    }
  });
  it("falls back to a non-streaming request when the gateway rejects streaming", async () => {
    const stub = stubFetchReturning((call) =>
      call === 1
        ? new Response('{"error":{"message":"stream not supported"}}', { status: 400 })
        : new Response(
            JSON.stringify({ choices: [{ message: { content: "whole body" } }], usage: { prompt_tokens: 3, completion_tokens: 4 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          ));
    try {
      const port = makePortForConfig(PROVIDERS.pollinations, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "whole body");
      strictEqual(res.promptTokens, 3);
      // First attempt streamed, the retry did not.
      strictEqual(stub.calls.length, 2);
      strictEqual(stub.calls[0]?.stream, true);
      strictEqual(stub.calls[1]?.stream, false);
    } finally {
      stub.restore();
    }
  });
  it("parses a JSON body directly when a gateway ignores the stream flag", async () => {
    const stub = stubFetchReturning(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "json, not sse" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    try {
      const port = makePortForConfig(PROVIDERS.pollinations, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "json, not sse");
      // No stream content-type means no wasted retry — the body is used as-is.
      strictEqual(stub.calls.length, 1);
    } finally {
      stub.restore();
    }
  });
  it("retries non-streaming when an SSE stream opens but carries nothing", async () => {
    const stub = stubFetchReturning((call) =>
      call === 1
        ? sseResponse(["data: [DONE]\n\n"])
        : new Response(JSON.stringify({ choices: [{ message: { content: "recovered" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }));
    try {
      const port = makePortForConfig(PROVIDERS.pollinations, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "recovered");
      strictEqual(stub.calls.length, 2);
      strictEqual(stub.calls[1]?.stream, false);
      // The dead stream is remembered: the next call does not re-attempt it.
      const second = await port({ model: "m", messages: [], tools: [] });
      strictEqual(second.ok, true);
      strictEqual(stub.calls.length, 3);
      strictEqual(stub.calls[2]?.stream, false);
    } finally {
      stub.restore();
    }
  });
  it("an idle stream is typed retryable timeout, not a terminal network error", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init?: { signal?: AbortSignal }) =>
      Promise.resolve(hangingSseResponse(init?.signal))) as typeof fetch;
    try {
      // First-byte budget must cover a body that never produces a full event,
      // so a small limit triggers the timeout path quickly.
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key", 50);
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, false);
      if (res.ok) return;
      strictEqual(res.retryable, "timeout");
      ok(/stalled|timed out/.test(res.error), res.error);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("--no-stream disables SSE entirely (whole-body request)", async () => {
    const stub = stubFetchReturning(() =>
      new Response(JSON.stringify({ choices: [{ message: { content: "plain" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    try {
      setStreamingEnabled(false);
      const port = makePortForConfig(PROVIDERS.nvidia, "test-key");
      const res = await port({ model: "m", messages: [], tools: [] });
      strictEqual(res.ok, true);
      if (!res.ok) return;
      strictEqual(res.text, "plain");
      strictEqual(stub.calls[0]?.stream, false);
    } finally {
      setStreamingEnabled(true);
      stub.restore();
    }
  });
});
