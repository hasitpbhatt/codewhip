import { describe, it } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import * as http from "node:http";
import * as os from "node:os";
import * as fs from "node:fs";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { clearModelCatalogCache, createServeServer, createShutdown, IpRateLimiter, resolveTarget, startServe, toLoopMessages } from "./serve.js";
import type { ServeOptions } from "./serve.js";
import { PROVIDERS, PROVIDER_IDS } from "./provider.js";
import { getProviderConfig, isLoopbackBaseUrl } from "./custom-providers.js";
import { resolveKey } from "./auth.js";
import { estimateCost, isAutoEligible } from "./router.js";

const TEST_CONFIG_DIR = fs.mkdtempSync(join(os.tmpdir(), "codewhip-serve-"));
for (const p of PROVIDER_IDS) {
  delete process.env[`${p.toUpperCase()}_API_KEY`];
}
process.env.CODEWHIP_CONFIG_DIR = TEST_CONFIG_DIR;

/** OpenAI-shaped non-streaming reply, as the upstream provider would send it. */
function openAiReply(content: string | null, toolCalls?: unknown[]): Response {
  const message: Record<string, unknown> = { role: "assistant", content };
  if (toolCalls !== undefined) message.tool_calls = toolCalls;
  return new Response(
    JSON.stringify({
      choices: [{ message }],
      usage: { prompt_tokens: 11, completion_tokens: 4 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

type Harness = {
  base: string;
  /** Requests the server made upstream, in order. */
  upstream: Array<{ url: string; body: string }>;
  /** Real fetch — the server's own fetch is stubbed, so tests need this. */
  client: typeof fetch;
  close: () => Promise<void>;
};

/**
 * The server stubs globalThis.fetch to fake the upstream provider, so tests
 * must NOT use globalThis.fetch to talk to the server — they would call the
 * stub. Every client request goes through this, captured before the stub.
 */
let clientFetch: typeof fetch = globalThis.fetch;

async function harness(opts: Partial<ServeOptions>, reply: () => Response): Promise<Harness> {
  const realFetch = globalThis.fetch;
  clientFetch = realFetch;
  const upstream: Array<{ url: string; body: string }> = [];
  globalThis.fetch = ((url: string, init: { body?: string }) => {
    upstream.push({ url, body: init.body ?? "" });
    return Promise.resolve(reply());
  }) as unknown as typeof fetch;
  const server = createServeServer({
    port: 0,
    host: "127.0.0.1",
    provider: "llm7",
    model: "default",
    ...opts,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${addr.port}`,
    upstream,
    client: realFetch,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      globalThis.fetch = realFetch;
    },
  };
}

function post(base: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return clientFetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("serve message translation", () => {
  it("maps every OpenAI role the loop understands", () => {
    const msgs = toLoopMessages([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    deepStrictEqual(msgs, [
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });
  it("carries tool_call_id through so the transcript stays pairable", () => {
    deepStrictEqual(toLoopMessages([{ role: "tool", content: "ok", tool_call_id: "call_9" }]), [
      { role: "tool", content: "ok", toolCallId: "call_9" },
    ]);
  });
  it("converts an assistant tool_calls array into LoopToolCall[]", () => {
    const msgs = toLoopMessages([
      { role: "assistant", content: "", tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path":"a"}' } }] },
    ]);
    deepStrictEqual(msgs[0].toolCalls, [{ id: "c1", name: "read", argsJson: '{"path":"a"}' }]);
  });
  it("flattens OpenAI content-part arrays into text", () => {
    deepStrictEqual(toLoopMessages([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]), [
      { role: "user", content: "ab" },
    ]);
  });
  it("drops messages with an unknown or missing role", () => {
    strictEqual(toLoopMessages([{ role: "wizard", content: "x" }, { content: "y" }]).length, 0);
  });
  it("returns nothing for a non-array messages field", () => {
    strictEqual(toLoopMessages(undefined).length, 0);
    strictEqual(toLoopMessages("nope").length, 0);
  });
});

describe("serve model routing", () => {
  const fallback = { provider: "llm7", model: "default" };
  it("splits provider:model at the FIRST colon, so model ids may keep theirs", () => {
    deepStrictEqual(resolveTarget("kilo:cohere/north-mini-code:free", fallback), {
      provider: "kilo",
      model: "cohere/north-mini-code:free",
    });
  });
  it("treats a bare provider id as that provider's default model", () => {
    deepStrictEqual(resolveTarget("nvidia", fallback), { provider: "nvidia", model: "moonshotai/kimi-k3" });
  });
  it("treats a bare model id as the default provider's model", () => {
    deepStrictEqual(resolveTarget("gpt-4o-mini", fallback), { provider: "llm7", model: "gpt-4o-mini" });
  });
  it("falls back to the server default when model is absent", () => {
    deepStrictEqual(resolveTarget("", fallback), fallback);
  });
  it("rejects an unknown provider prefix instead of guessing", () => {
    ok("error" in resolveTarget("nope:model", fallback));
    ok("error" in resolveTarget("nvidia:", fallback));
  });
  it("auto picks a keyed, non-loopback provider with its default model", () => {
    const t = resolveTarget("auto", fallback);
    ok(!("error" in t), `auto must resolve, got: ${JSON.stringify(t)}`);
    const cfg = getProviderConfig(t.provider);
    ok(cfg !== null, `auto picked an unknown provider: ${t.provider}`);
    ok(!isLoopbackBaseUrl(cfg.baseUrl), `auto must never pick a loopback runtime: ${t.provider}`);
    ok(resolveKey(t.provider).key.length > 0, `auto must never route at a keyless provider: ${t.provider}`);
    strictEqual(t.model, cfg.defaultModel);
  });
  it("auto as the server default resolves empty and bare-model requests", () => {
    const auto = { provider: "auto", model: "auto" };
    const empty = resolveTarget("", auto);
    ok(!("error" in empty), `empty model on auto default must resolve: ${JSON.stringify(empty)}`);
    const pinned = resolveTarget("gpt-4o-mini", auto);
    ok(!("error" in pinned), `bare model on auto default must resolve: ${JSON.stringify(pinned)}`);
    if (!("error" in pinned)) strictEqual(pinned.model, "gpt-4o-mini");
  });
  it("auto never spends a user-supplied key on an untracked-cost route", () => {
    // sensenova is the paid-key case: untracked cost, no anonymous fallback.
    const cfg = getProviderConfig("sensenova");
    ok(cfg !== undefined && cfg !== null);
    strictEqual(estimateCost("sensenova", cfg.defaultModel, 1000, 1000), null);
    const prev = process.env[cfg.envVar];
    delete process.env[cfg.envVar];
    process.env[cfg.envVar] = "paid-key-for-test";
    try {
      strictEqual(resolveKey("sensenova").source, "env");
      strictEqual(isAutoEligible("sensenova", cfg.defaultModel), false);
      for (let i = 0; i < 30; i++) {
        const t = resolveTarget("auto", fallback);
        ok(!("error" in t), `auto must resolve, got: ${JSON.stringify(t)}`);
        if (!("error" in t)) ok(t.provider !== "sensenova", "auto must not route at a paid-key untracked provider");
      }
    } finally {
      if (prev === undefined) delete process.env[cfg.envVar];
      else process.env[cfg.envVar] = prev;
    }
  });
  it("CODEWHIP_AUTO_INCLUDE_UNTRACKED=1 opts paid keys back into auto", () => {
    const cfg = getProviderConfig("sensenova");
    ok(cfg !== undefined && cfg !== null);
    const prevKey = process.env[cfg.envVar];
    const prevOpt = process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED;
    delete process.env[cfg.envVar];
    process.env[cfg.envVar] = "paid-key-for-test";
    process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED = "1";
    try {
      strictEqual(isAutoEligible("sensenova", cfg.defaultModel), true);
      ok(!("error" in resolveTarget("auto", fallback)));
    } finally {
      if (prevKey === undefined) delete process.env[cfg.envVar];
      else process.env[cfg.envVar] = prevKey;
      if (prevOpt === undefined) delete process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED;
      else process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED = prevOpt;
    }
  });
});

describe("serve refuses to expose your keys", () => {
  it("throws rather than binding a non-loopback host without a token", () => {
    let threw = false;
    try {
      startServe({ port: 0, host: "0.0.0.0", provider: "llm7", model: "default" });
    } catch (err) {
      threw = true;
      ok(err instanceof Error && err.message.includes("--token"), String(err));
    }
    strictEqual(threw, true);
  });
});

describe("serve shutdown is idempotent", () => {
  it("does not stack close listeners when signals arrive repeatedly", async () => {
    // Regression: every server.close() adds a 'close' listener, so a signal
    // handler that calls close() per keypress tripped Node's
    // "MaxListenersExceededWarning: 11 close listeners added to [Server]".
    const server = createServeServer({ port: 0, host: "127.0.0.1", provider: "llm7", model: "default" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const exits: number[] = [];
    const c = createShutdown(server, (code) => exits.push(code));
    for (let i = 0; i < 12; i++) c.shutdown();
    strictEqual(server.listenerCount("close"), 1);
    strictEqual(c.isShuttingDown(), true);
    // Calls 2..12 are "the operator is impatient" — they force the exit.
    strictEqual(exits.length, 11);
  });
  it("closes idle keep-alive sockets, so the process can actually exit", async () => {
    // The hang is what makes someone press Ctrl-C again in the first place:
    // server.close() waits for connections, and an idle keep-alive socket has
    // no natural end.
    const server = createServeServer({ port: 0, host: "127.0.0.1", provider: "llm7", model: "default" });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({ port, host: "127.0.0.1", path: "/health", agent }, (res) => {
        res.resume();
        res.on("end", () => resolve());
      });
      req.on("error", reject);
    });
    const exited = await new Promise<boolean>((resolve) => {
      createShutdown(server, () => resolve(true)).shutdown();
      const bail = setTimeout(() => resolve(false), 3000);
      bail.unref();
    });
    agent.destroy();
    strictEqual(exited, true);
  });
});

describe("serve HTTP surface", () => {
  it("answers /health without touching a provider", async () => {
    const h = await harness({}, () => openAiReply("x"));
    try {
      const res = await h.client(`${h.base}/health`);
      strictEqual(res.status, 200);
      const body = (await res.json()) as { status: string; providers: number };
      strictEqual(body.status, "ok");
      ok(body.providers > 50, String(body.providers));
      strictEqual(h.upstream.length, 0);
    } finally {
      await h.close();
    }
  });
  it("lists every provider as <provider>:<default-model>", async () => {
    const h = await harness({}, () => openAiReply("x"));
    try {
      const res = await h.client(`${h.base}/v1/models`);
      strictEqual(res.status, 200);
      const body = (await res.json()) as { object: string; data: Array<{ id: string; owned_by: string }> };
      strictEqual(body.object, "list");
      ok(body.data.some((m) => m.id === "1min:gpt-4o-mini"), JSON.stringify(body.data.slice(0, 3)));
    } finally {
      await h.close();
    }
  });
  it("returns an OpenAI-shaped completion and passes the model through", async () => {
    const h = await harness({}, () => openAiReply("pong"));
    try {
      const res = await post(h.base, { model: "gpt-4o-mini", messages: [{ role: "user", content: "ping" }] });
      strictEqual(res.status, 200);
      const body = (await res.json()) as {
        id: string;
        object: string;
        model: string;
        choices: Array<{ message: { content: string }; finish_reason: string }>;
        usage: { prompt_tokens: number; total_tokens: number };
      };
      strictEqual(body.object, "chat.completion");
      strictEqual(body.model, "gpt-4o-mini");
      strictEqual(body.choices[0].message.content, "pong");
      strictEqual(body.choices[0].finish_reason, "stop");
      strictEqual(body.usage.prompt_tokens, 11);
      strictEqual(body.usage.total_tokens, 15);
      ok(body.id.startsWith("chatcmpl-"), body.id);
    } finally {
      await h.close();
    }
  });
  it("routes a provider:model request to that provider's endpoint", async () => {
    const h = await harness({}, () => openAiReply("ok"));
    try {
      // kilo is keyless, so this exercises routing rather than key resolution.
      const res = await post(h.base, { model: "kilo:cohere/north-mini-code:free", messages: [{ role: "user", content: "hi" }] });
      strictEqual(res.status, 200);
      strictEqual(h.upstream.length, 1);
      ok(h.upstream[0].url.startsWith(PROVIDERS.kilo.baseUrl), h.upstream[0].url);
      // The model id keeps its own colon after the provider is split off.
      strictEqual((JSON.parse(h.upstream[0].body) as { model: string }).model, "cohere/north-mini-code:free");
    } finally {
      await h.close();
    }
  });
  it("fails with 401 and names the env var when the routed provider has no key", async () => {
    const h = await harness({}, () => openAiReply("ok"));
    try {
      const res = await post(h.base, { model: "nvidia:moonshotai/kimi-k3", messages: [{ role: "user", content: "hi" }] });
      strictEqual(res.status, 401);
      const body = (await res.json()) as { error: { message: string; code: string } };
      strictEqual(body.error.code, "missing_provider_key");
      ok(body.error.message.includes("NVIDIA_API_KEY"), body.error.message);
      // No key means no upstream call — and no key ever reaches the client.
      strictEqual(h.upstream.length, 0);
    } finally {
      await h.close();
    }
  });
  it("emits a well-formed SSE stream even though the upstream does not stream", async () => {
    const h = await harness({}, () => openAiReply("streamed"));
    try {
      const res = await post(h.base, { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], stream: true });
      strictEqual(res.status, 200);
      ok((res.headers.get("content-type") ?? "").includes("text/event-stream"), res.headers.get("content-type") ?? "");
      const text = await res.text();
      ok(text.includes('"object":"chat.completion.chunk"'), text);
      ok(text.includes('"role":"assistant"'), text);
      ok(text.includes('"content":"streamed"'), text);
      ok(text.includes('"finish_reason":"stop"'), text);
      ok(text.trimEnd().endsWith("data: [DONE]"), text);
    } finally {
      await h.close();
    }
  });
  it("appends a usage chunk only when stream_options.include_usage asks for it", async () => {
    const h = await harness({}, () => openAiReply("hi"));
    try {
      const plain = await (await post(h.base, { model: "m", messages: [{ role: "user", content: "x" }], stream: true })).text();
      ok(!plain.includes('"usage"'), plain);
      const withUsage = await (
        await post(h.base, {
          model: "m",
          messages: [{ role: "user", content: "x" }],
          stream: true,
          stream_options: { include_usage: true },
        })
      ).text();
      ok(withUsage.includes('"total_tokens"'), withUsage);
    } finally {
      await h.close();
    }
  });
  it("surfaces tool calls in the OpenAI shape and reports finish_reason tool_calls", async () => {
    const h = await harness({}, () =>
      openAiReply(null, [{ id: "c1", function: { name: "read", arguments: '{"path":"a.ts"}' } }])
    );
    try {
      const body = (await (
        await post(h.base, { model: "m", messages: [{ role: "user", content: "x" }] })
      ).json()) as { choices: Array<{ finish_reason: string; message: { tool_calls: Array<{ function: { name: string } }> } }> };
      strictEqual(body.choices[0].finish_reason, "tool_calls");
      strictEqual(body.choices[0].message.tool_calls[0].function.name, "read");
    } finally {
      await h.close();
    }
  });
  it("requires the bearer token when one is configured", async () => {
    const h = await harness({ token: "s3cret" }, () => openAiReply("x"));
    try {
      strictEqual((await h.client(`${h.base}/health`)).status, 200);
      strictEqual((await post(h.base, { model: "m", messages: [{ role: "user", content: "x" }] })).status, 401);
      const wrong = await post(h.base, { model: "m", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer nope" });
      strictEqual(wrong.status, 401);
      const right = await post(h.base, { model: "m", messages: [{ role: "user", content: "x" }] }, { authorization: "Bearer s3cret" });
      strictEqual(right.status, 200);
    } finally {
      await h.close();
    }
  });
  it("gates playground, stats, and the auth UI behind the token (health stays public)", async () => {
    const h = await harness({ token: "s3cret", authUi: true }, () => openAiReply("x"));
    try {
      strictEqual((await h.client(`${h.base}/health`)).status, 200);
      for (const p of ["/playground", "/stats", "/auth"]) {
        strictEqual((await h.client(`${h.base}${p}`)).status, 401, p);
        const authed = await h.client(`${h.base}${p}`, { headers: { authorization: "Bearer s3cret" } });
        strictEqual(authed.status, 200, p);
        await authed.text();
      }
    } finally {
      await h.close();
    }
  });
  it("leaves playground public when no token is configured (loopback default)", async () => {
    const h = await harness({}, () => openAiReply("x"));
    try {
      strictEqual((await h.client(`${h.base}/playground`)).status, 200);
    } finally {
      await h.close();
    }
  });
  it("serves aggregated stats at /stats but not per-request history", async () => {
    const h = await harness({ token: "s3cret", authUi: true }, () => openAiReply("x"));
    try {
      // Unauthenticated still 401.
      strictEqual((await h.client(`${h.base}/stats`)).status, 401);
      // Authed gets 200 HTML with aggregate data.
      const authed = await h.client(`${h.base}/stats`, { headers: { authorization: "Bearer s3cret" } });
      strictEqual(authed.status, 200);
      const html = await authed.text();
      ok(html.includes("<title>codewhip stats</title>"), "stats title");
      ok(html.includes("calls recorded"), "contains aggregate marker");
      ok(html.includes("per-request history is never served"), "per-request disclaimer");
    } finally {
      await h.close();
    }
  });
  it("rejects malformed JSON, empty messages and unknown routes with OpenAI-shaped errors", async () => {
    const h = await harness({}, () => openAiReply("x"));
    try {
      const badJson = await h.client(`${h.base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      });
      strictEqual(badJson.status, 400);
      const noMessages = await post(h.base, { model: "m", messages: [] });
      strictEqual(noMessages.status, 400);
      const body = (await noMessages.json()) as { error: { message: string; code: string } };
      ok(body.error.message.length > 0, JSON.stringify(body));
      strictEqual(body.error.code, "invalid_messages");
      const notFound = await h.client(`${h.base}/v1/nope`);
      strictEqual(notFound.status, 404);
      strictEqual(h.upstream.length, 0);
    } finally {
      await h.close();
    }
  });
  it("does not serve the auth UI when authUi is off", async () => {
    const h = await harness({ authUi: false }, () => openAiReply("x"));
    try {
      strictEqual((await h.client(`${h.base}/auth`)).status, 404);
    } finally {
      await h.close();
    }
  });
  it("serves the auth UI, then round-trips a stored key", async () => {
    const tmpDir = await mkdtemp(join(os.tmpdir(), "cw-serve-"));
    const realConfig = process.env["CODEWHIP_CONFIG_DIR"];
    process.env["CODEWHIP_CONFIG_DIR"] = tmpDir;
    const h = await harness({ authUi: true }, () => openAiReply("ok"));
    try {
      // The listing shows source "none" for an untouched provider.
      const html = await (await h.client(`${h.base}/auth`)).text();
      ok(html.includes("<title>codewhip auth</title>"), html.slice(0, 50));
      const saved = await h.client(`${h.base}/auth/groq`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: "sk-test-key" }),
      });
      strictEqual(saved.status, 200);
      const savedBody = (await saved.json()) as { id: string; source: string };
      strictEqual(savedBody.id, "groq");
      strictEqual(savedBody.source, "file");
      const get = (await h.client(`${h.base}/auth/groq`)).json() as Promise<{ id: string; source: string; hasKey: boolean }>;
      const got = await get;
      strictEqual(got.source, "file");
      ok(got.hasKey, "hasKey should be true after save");
      // The key is never echoed.
      ok(!JSON.stringify(got).includes("sk-test-key"), "key must not be echoed");
      const del = await h.client(`${h.base}/auth/groq`, { method: "DELETE" });
      strictEqual(del.status, 200);
      const after = (await del.json()) as { source: string };
      strictEqual(after.source, "none");
    } finally {
      if (realConfig === undefined) delete process.env["CODEWHIP_CONFIG_DIR"];
      else process.env["CODEWHIP_CONFIG_DIR"] = realConfig;
      await h.close();
    }
  });
  it("rejects unknown providers in the auth API", async () => {
    const h = await harness({ authUi: true }, () => openAiReply("ok"));
    try {
      const res = await h.client(`${h.base}/auth/nope-nope`);
      strictEqual(res.status, 404);
    } finally {
      await h.close();
    }
  });
});

describe("auth UI registers custom endpoints", () => {
  /** These tests write custom-providers.json, so they get a throwaway dir. */
  async function withTempConfig<T>(fn: () => Promise<T>): Promise<T> {
    const tmp = await mkdtemp(join(os.tmpdir(), "cw-serve-custom-"));
    const prev = process.env["CODEWHIP_CONFIG_DIR"];
    process.env["CODEWHIP_CONFIG_DIR"] = tmp;
    // The module-level /v1/models cache is keyed by wall-clock, not config dir;
    // a prior test's sweep would otherwise leak stale rows into this temp dir.
    clearModelCatalogCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env["CODEWHIP_CONFIG_DIR"];
      else process.env["CODEWHIP_CONFIG_DIR"] = prev;
    }
  }

  function register(base: string, body: unknown): Promise<Response> {
    return clientFetch(`${base}/auth/_custom`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  const GATEWAY = {
    id: "my-gateway",
    baseUrl: "https://gateway.example.com/",
    model: "my-model",
    envVar: "MY_GATEWAY_API_KEY",
    keyUrl: "https://gateway.example.com/keys",
  };

  it("registers from the UI, then the new endpoint is a real provider", async () => {
    await withTempConfig(async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        // The page carries a form, not just a table of keys.
        const html = await (await h.client(`${h.base}/auth`)).text();
        ok(html.includes('name="baseUrl"'), html.slice(0, 120));
        ok(html.includes("/auth/_custom"), "the form must post to the register route");

        const added = await register(h.base, GATEWAY);
        strictEqual(added.status, 201);
        const body = (await added.json()) as { id: string; baseUrl: string; defaultModel: string; envVar: string; local: boolean };
        strictEqual(body.id, "my-gateway");
        // The trailing slash is trimmed, same as `codewhip provider add`.
        strictEqual(body.baseUrl, "https://gateway.example.com");
        strictEqual(body.defaultModel, "my-model");
        strictEqual(body.local, false);

        // It is a provider now: /v1/models lists it…
        const models = (await (await h.client(`${h.base}/v1/models`)).json()) as { data: Array<{ id: string }> };
        ok(models.data.some((m) => m.id === "my-gateway:my-model"), JSON.stringify(models.data.slice(-3)));

        // …and its key can be saved through the same UI.
        const keyed = await h.client(`${h.base}/auth/my-gateway`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ key: "sk-custom-key" }),
        });
        strictEqual(keyed.status, 200);
        ok(!(await keyed.text()).includes("sk-custom-key"), "keys are never echoed");

        // GET /auth/_custom lists the customs only, and marks them custom.
        const list = (await (await h.client(`${h.base}/auth/_custom`)).json()) as { data: Array<{ id: string; custom: boolean }> };
        strictEqual(list.data.length, 1);
        strictEqual(list.data[0].id, "my-gateway");
        strictEqual(list.data[0].custom, true);
      } finally {
        await h.close();
      }
    });
  });

  it("removes a custom endpoint, and refuses builtins and unknowns", async () => {
    await withTempConfig(async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        strictEqual((await register(h.base, GATEWAY)).status, 201);
        const removed = await h.client(`${h.base}/auth/_custom/my-gateway`, { method: "DELETE" });
        strictEqual(removed.status, 200);
        const models = (await (await h.client(`${h.base}/v1/models`)).json()) as { data: Array<{ id: string }> };
        ok(!models.data.some((m) => m.id === "my-gateway:my-model"), "removed provider must leave the model list");

        const builtin = await h.client(`${h.base}/auth/_custom/nvidia`, { method: "DELETE" });
        strictEqual(builtin.status, 400);
        const unknown = await h.client(`${h.base}/auth/_custom/ghost`, { method: "DELETE" });
        strictEqual(unknown.status, 404);
      } finally {
        await h.close();
      }
    });
  });

  it("applies the CLI's own validation, and never throws on a bad shape", async () => {
    await withTempConfig(async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const cases: Array<{ label: string; body: unknown; expect: string }> = [
          { label: "builtin id", body: { ...GATEWAY, id: "nvidia" }, expect: "builtin" },
          { label: "plain http off-loopback", body: { ...GATEWAY, id: "insecure", baseUrl: "http://insecure.example.com" }, expect: "https://" },
          { label: "lowercase env var", body: { ...GATEWAY, id: "env-bad", envVar: "lower" }, expect: "UPPER_SNAKE" },
          { label: "empty id", body: { ...GATEWAY, id: "" }, expect: "bad id" },
          // A JSON body is not TypeScript: normalize() trims strings, so a
          // number here used to be a TypeError inside the request handler.
          { label: "non-string id", body: { ...GATEWAY, id: 42 }, expect: "bad id" },
          { label: "non-string url", body: { ...GATEWAY, id: "url-bad", baseUrl: { href: "x" } }, expect: "bad --base-url" },
          { label: "garbage timeout", body: { ...GATEWAY, id: "time-bad", timeoutMs: "soon" }, expect: "bad --timeout-ms" },
        ];
        for (const c of cases) {
          const res = await register(h.base, c.body);
          strictEqual(res.status, 400, `${c.label}: expected 400`);
          const err = ((await res.json()) as { error: { message: string; code: string } }).error;
          strictEqual(err.code, "invalid_provider", `${c.label}: ${err.message}`);
          ok(err.message.includes(c.expect), `${c.label}: ${err.message}`);
        }
        // Nothing was written: the only customs list is still empty.
        const list = (await (await h.client(`${h.base}/auth/_custom`)).json()) as { data: unknown[] };
        strictEqual(list.data.length, 0);
      } finally {
        await h.close();
      }
    });
  });

  it("registers a loopback runtime, which then needs no key at all", async () => {
    await withTempConfig(async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const added = await register(h.base, {
          id: "ollama-local",
          baseUrl: "http://127.0.0.1:11434",
          model: "llama3",
          envVar: "OLLAMA_LOCAL_API_KEY",
        });
        strictEqual(added.status, 201);
        const body = (await added.json()) as { id: string; local: boolean };
        strictEqual(body.local, true);

        // The promise: a local runtime resolves with nothing stored, so the
        // request reaches it instead of dying on "no key".
        const res = await post(h.base, { model: "ollama-local:llama3", messages: [{ role: "user", content: "hi" }] });
        strictEqual(res.status, 200);
        strictEqual(h.upstream.length, 1);
        ok(h.upstream[0].url.startsWith("http://127.0.0.1:11434"), h.upstream[0].url);
      } finally {
        await h.close();
      }
    });
  });

  it("is not reachable when the auth UI is disabled", async () => {
    const h = await harness({ authUi: false }, () => openAiReply("ok"));
    try {
      strictEqual((await register(h.base, GATEWAY)).status, 404);
    } finally {
      await h.close();
    }
  });
});

describe("IpRateLimiter (fixed window, 30 req / 60s per IP)", () => {
  it("admits up to the limit, then refuses with a Retry-After", () => {
    const limiter = new IpRateLimiter(3, 60_000);
    const t0 = 1_000_000;
    strictEqual(limiter.check("1.2.3.4", t0).admitted, true);
    strictEqual(limiter.check("1.2.3.4", t0 + 1).admitted, true);
    strictEqual(limiter.check("1.2.3.4", t0 + 2).admitted, true);
    const denied = limiter.check("1.2.3.4", t0 + 3);
    strictEqual(denied.admitted, false);
    if (denied.admitted) return;
    ok(denied.retryAfterSec > 0 && denied.retryAfterSec <= 60, `retryAfterSec=${denied.retryAfterSec}`);
  });

  it("resets the window after it expires", () => {
    const limiter = new IpRateLimiter(2, 1_000);
    const t0 = 5_000_000;
    limiter.check("1.2.3.4", t0);
    limiter.check("1.2.3.4", t0);
    strictEqual(limiter.check("1.2.3.4", t0).admitted, false);
    strictEqual(limiter.check("1.2.3.4", t0 + 1_001).admitted, true);
  });

  it("tracks IPs independently", () => {
    const limiter = new IpRateLimiter(1, 60_000);
    strictEqual(limiter.check("10.0.0.1").admitted, true);
    strictEqual(limiter.check("10.0.0.1").admitted, false);
    strictEqual(limiter.check("10.0.0.2").admitted, true);
  });

  it("429s the key-spending endpoint past the cap and sends Retry-After", async () => {
    const h = await harness({}, () => openAiReply("ok"));
    try {
      // 30 admitted requests, all from the same loopback peer.
      for (let i = 0; i < 30; i++) {
        const res = await post(h.base, { model: "kilo:some-model", messages: [{ role: "user", content: "hi" }] });
        strictEqual(res.status, 200, `request ${i + 1} should be admitted`);
      }
      const res = await post(h.base, { model: "kilo:some-model", messages: [{ role: "user", content: "hi" }] });
      strictEqual(res.status, 429);
      const retryAfter = res.headers.get("retry-after");
      ok(retryAfter !== null && Number(retryAfter) > 0, `Retry-After=${retryAfter}`);
      const body = (await res.json()) as { error: { code: string } };
      strictEqual(body.error.code, "rate_limited");
      // The 31st request never reached an upstream: the limiter fires before
      // the body is read, so no key was spent.
      strictEqual(h.upstream.length, 30);
    } finally {
      await h.close();
    }
  });
});

describe("serve /v1/models live catalog", () => {
  /** A fetch stub that answers models listings but otherwise chat-replies. */
  function catalogAwareFetch(upstream: Array<{ url: string; body?: string }>): void {
    globalThis.fetch = ((url: string, init?: { body?: string }) => {
      upstream.push({ url, body: init?.body ?? "" });
      if (url.endsWith("/models") || url.endsWith("/models/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ object: "list", data: [{ id: "m-alpha" }, { id: "m-beta" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      return Promise.resolve(openAiReply("ok"));
    }) as unknown as typeof fetch;
  }

  it("expands keyed providers into <provider>:<model> rows, defaults for the rest", async () => {
    clearModelCatalogCache();
    const h = await harness({}, () => openAiReply("ok"));
    try {
      catalogAwareFetch(h.upstream);
      const res = await h.client(`${h.base}/v1/models`);
      strictEqual(res.status, 200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      const ids = body.data.map((m) => m.id);
      // pollinations resolves an anonymous key -> its catalog expands.
      ok(ids.includes("pollinations:m-alpha"), "expanded row missing");
      ok(ids.includes("pollinations:m-beta"), "expanded row missing");
      // nvidia has no key in tests -> it keeps its default-model row.
      ok(ids.includes(`nvidia:${PROVIDERS.nvidia.defaultModel}`), "fallback row missing");
    } finally {
      await h.close();
      clearModelCatalogCache();
    }
  });

  it("--ping-models filters to providers whose listModels probe succeeded", async () => {
    clearModelCatalogCache();
    const h = await harness({ pingModels: true }, () => openAiReply("ok"));
    try {
      catalogAwareFetch(h.upstream);
      const res = await h.client(`${h.base}/v1/models`);
      strictEqual(res.status, 200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      const ids = body.data.map((m) => m.id);
      ok(ids.includes("pollinations:m-alpha"), "live provider's catalog missing");
      // A provider we could not probe (no key) is absent, not defaulted.
      ok(!ids.some((id) => id.startsWith("nvidia:")), "unprobed provider should be filtered out");
    } finally {
      await h.close();
      clearModelCatalogCache();
    }
  });
});
