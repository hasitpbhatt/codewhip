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
import { enableEntries, loadAllowedEntries, saveAllowedEntries } from "./model-allowlist.js";
import { resolveKey } from "./auth.js";
import { estimateCost, isAutoEligible } from "./router.js";
import { resetProviderStatsForTest } from "./provider-stats.js";

const TEST_CONFIG_DIR = fs.mkdtempSync(join(os.tmpdir(), "codewhip-serve-"));
for (const p of PROVIDER_IDS) {
  delete process.env[`${p.toUpperCase()}_API_KEY`];
}
process.env.CODEWHIP_CONFIG_DIR = TEST_CONFIG_DIR;

// Deny-by-default gate: most tests below route across the registry, so seed
// the exact combos they exercise — every builtin's default model, plus the
// specials. The empty-allowlist behavior has its own describe that points
// CODEWHIP_CONFIG_DIR at a throwaway dir.
saveAllowedEntries([
  ...PROVIDER_IDS.map((p) => `${p}:${PROVIDERS[p].defaultModel}`),
  "llm7:gpt-4o-mini",
  "llm7:m",
  "kilo:some-model",
  "kilo:cohere/north-mini-code:free",
  "pollinations:m-alpha",
  "pollinations:m-beta",
]);

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
  it("provider:auto health-picks inside that provider — never the literal word \"auto\"", () => {
    // Regression: `kilo:auto` used to resolve to model "auto" and ship that
    // word upstream, where the provider rejects it (a user-visible 4xx/5xx).
    for (let i = 0; i < 20; i++) {
      const t = resolveTarget("kilo:auto", fallback);
      ok(!("error" in t), `kilo:auto must resolve: ${JSON.stringify(t)}`);
      if (!("error" in t)) {
        strictEqual(t.provider, "kilo");
        ok(t.model !== "auto", '"auto" is a routing word, not an upstream model id');
        ok(loadAllowedEntries().includes(`kilo:${t.model}`), `scoped auto must stay allowlisted: kilo:${t.model}`);
      }
    }
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
      const body = (await res.json()) as { status: string };
      strictEqual(body.status, "ok");
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
  it("auto silently hops to the next healthy target on a 429 (client sees 200)", async () => {
    let calls = 0;
    const h = await harness({ provider: "auto", model: "auto" }, () => {
      calls += 1;
      return calls === 1
        ? new Response(JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }), { status: 429, headers: { "content-type": "application/json" } })
        : openAiReply("recovered");
    });
    try {
      const res = await post(h.base, { model: "auto", messages: [{ role: "user", content: "hi" }] });
      strictEqual(res.status, 200);
      // Two upstream calls, one failure the client never sees.
      strictEqual(h.upstream.length, 2);
      const body = (await res.json()) as { choices: Array<{ message: { content: string } }>; serviced_by: string };
      strictEqual(body.choices[0].message.content, "recovered");
      ok(typeof body.serviced_by === "string" && body.serviced_by.length > 0, JSON.stringify(body));
    } finally {
      await h.close();
    }
  });
  it("a pinned model never hops: its 429 is returned as-is", async () => {
    const h = await harness({}, () => new Response("slow", { status: 429 }));
    try {
      // llm7 is keyless, so this exercises pinning rather than key resolution.
      const res = await post(h.base, { model: "llm7:default", messages: [{ role: "user", content: "hi" }] });
      strictEqual(res.status, 429);
      strictEqual(h.upstream.length, 1);
    } finally {
      await h.close();
    }
  });
  it("auto gives up after 3 upstream attempts and returns the last error", async () => {
    const h = await harness({ provider: "auto", model: "auto" }, () => new Response("down", { status: 503 }));
    try {
      const res = await post(h.base, { model: "auto", messages: [{ role: "user", content: "hi" }] });
      strictEqual(res.status, 502);
      strictEqual(h.upstream.length, 3);
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
  it("serves /playground and /auth pages whose inline scripts parse", async () => {
    const h = await harness({ authUi: true }, () => openAiReply("x"));
    try {
      for (const p of ["/playground", "/auth"]) {
        const res = await h.client(`${h.base}${p}`);
        strictEqual(res.status, 200, p);
        const html = await res.text();
        // Regression guard: a `\n` inside the page template literal once
        // reached the browser as a raw newline inside a JS string literal,
        // killing the whole script — the badge stayed on "loading…" forever.
        const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
        ok(scripts.length > 0, `${p} has an inline script`);
        for (const src of scripts) {
          let error: unknown;
          try {
            new Function(src);
          } catch (e) {
            error = e;
          }
          ok(error === undefined, `${p} inline script parses (${String(error)})`);
        }
      }
      const page = await (await h.client(`${h.base}/playground`)).text();
      ok(page.includes('<option value="auto" selected>'), "auto pre-selected in static markup");
      const authPage = await (await h.client(`${h.base}/auth`)).text();
      ok(authPage.includes('class="mnew"') && authPage.includes('data-mact="add"'), "accordion offers a custom-model input");
      // saveModels must send only TICKED rows — the PUT replaces the whole
      // provider set, so sending every visible id enables the entire catalog.
      ok(authPage.includes("input[type=checkbox]:checked"), "consent save collects checked boxes only");
      ok(!authPage.includes('"auto" = provider-scoped'), 'add-model input must not advertise "auto" (and its raw quotes broke the attribute)');
      // IA copy: the vocabulary points at the playground, not at internals.
      ok(authPage.includes("providers & models"), 'nav says "providers & models"');
      ok(!authPage.includes("keys & providers"), "old nav label is gone");
      ok(authPage.includes("Choose models the playground may run"), "accordion names its real effect");
      ok(authPage.includes('data-mact="rec"'), "accordion offers Enable recommended");
      ok(authPage.includes("#prov-"), "hash deep link opens the named provider panel");
      const pgPage = await (await h.client(`${h.base}/playground`)).text();
      ok(pgPage.includes('id="starter"'), "playground empty state offers the starter set");
      ok(pgPage.includes("free ones first"), "auto option explains what auto picks");
      // Revamp contract (commits 3–4): theme + status pill boot everywhere,
      // disclosures speak aria, and the save verdict slot is announced.
      for (const [name, src] of [["auth", authPage], ["playground", pgPage]] as const) {
        ok(src.includes('id="theme"'), `${name}: theme toggle present`);
        ok(src.includes("cw.theme"), `${name}: theme persists to localStorage`);
        ok(src.includes('id="pill"'), `${name}: header status pill present`);
      }
      ok(authPage.includes('aria-expanded'), "disclosures expose open/closed state");
      ok(authPage.includes('aria-controls="models-'), "Choose models controls its panel");
      ok(authPage.includes('role="status"'), "save verdict slot is announced");
      ok(authPage.includes("refreshGroupCounts"), "group counts re-sync on save/tick");
      ok(authPage.includes("aria-describedby"), "row badges are tied to their checkbox");
      ok(pgPage.includes('role="log"'), "chat is a log, not a per-token flood");
      ok(pgPage.includes('id="srStatus"'), "one screen-reader announcement per reply");
      ok(pgPage.includes('id="modelChip"'), "composer shows the active model");
      ok(pgPage.includes('id="inspJson"'), "request inspector ships with the page");
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
      ok(!html.includes("<thead>") || html.includes('scope="col"'), "table headers are scoped when rows exist");
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
      const get = (await h.client(`${h.base}/auth/groq`)).json() as Promise<{ id: string; hasKey: boolean }>;
      const got = await get;
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
  /** A fetch stub that answers models listings but otherwise chat-replies.
   *  m-omega is live-but-never-enabled: it must not appear in /v1/models. */
  function catalogAwareFetch(upstream: Array<{ url: string; body?: string }>): void {
    globalThis.fetch = ((url: string, init?: { body?: string }) => {
      upstream.push({ url, body: init?.body ?? "" });
      if (url.endsWith("/models") || url.endsWith("/models/")) {
        return Promise.resolve(
          new Response(JSON.stringify({ object: "list", data: [{ id: "m-alpha" }, { id: "m-beta" }, { id: "m-omega" }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
      return Promise.resolve(openAiReply("ok"));
    }) as unknown as typeof fetch;
  }

  it("lists exactly the enabled ids — live catalogs never expand access", async () => {
    clearModelCatalogCache();
    const h = await harness({}, () => openAiReply("ok"));
    try {
      catalogAwareFetch(h.upstream);
      const res = await h.client(`${h.base}/v1/models`);
      strictEqual(res.status, 200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      const ids = new Set(body.data.map((m) => m.id));
      const allowed = new Set(loadAllowedEntries());
      // Every emitted row is an enabled entry…
      for (const id of ids) ok(allowed.has(id), `non-enabled row emitted: ${id}`);
      // …and every enabled row appears even when no probe listed it
      // (nvidia is keyless here — its probe cannot succeed).
      ok(ids.has(`nvidia:${PROVIDERS.nvidia.defaultModel}`), "enabled keyless-provider row missing");
      // A live model that was never enabled must not sneak in.
      ok(!ids.has("pollinations:m-omega"), "un-enabled live row leaked");
    } finally {
      await h.close();
      clearModelCatalogCache();
    }
  });

  it("--ping-models narrows the enabled rows to ids the live probe confirmed", async () => {
    clearModelCatalogCache();
    const h = await harness({ pingModels: true }, () => openAiReply("ok"));
    try {
      catalogAwareFetch(h.upstream);
      const res = await h.client(`${h.base}/v1/models`);
      strictEqual(res.status, 200);
      const body = (await res.json()) as { data: Array<{ id: string }> };
      const ids = body.data.map((m) => m.id);
      ok(ids.includes("pollinations:m-alpha"), "enabled + live row missing");
      // Enabled, but the stubbed catalog says the model does not exist.
      ok(!ids.includes("kilo:some-model"), "enabled-but-not-live row must be filtered");
      // A provider we could not probe (no key) is absent, not defaulted.
      ok(!ids.some((id) => id.startsWith("nvidia:")), "unprobed provider should be filtered out");
    } finally {
      await h.close();
      clearModelCatalogCache();
    }
  });

  it("?refresh=1 bypasses the 60s cache and rebuilds the sweep", async () => {
    clearModelCatalogCache();
    const h = await harness({ pingModels: true }, () => openAiReply("ok"));
    try {
      // First sweep: the stub answers with m-alpha/m-beta.
      let catalog = [{ id: "m-alpha" }, { id: "m-beta" }];
      globalThis.fetch = ((url: string) => {
        if (url.endsWith("/models") || url.endsWith("/models/")) {
          return Promise.resolve(
            new Response(JSON.stringify({ object: "list", data: catalog }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          );
        }
        return Promise.resolve(openAiReply("ok"));
      }) as unknown as typeof fetch;

      const first = (await (await h.client(`${h.base}/v1/models`)).json()) as { data: Array<{ id: string }> };
      ok(first.data.some((m) => m.id === "pollinations:m-alpha"), "first sweep should keep the live-confirmed row");

      // Upstream catalog changes; a cached request must still serve the old
      // probe rows, while ?refresh=1 must re-sweep and pick the change up.
      // m-gamma is not enabled, so after refresh pollinations lists nothing.
      catalog = [{ id: "m-gamma" }];
      const cached = (await (await h.client(`${h.base}/v1/models`)).json()) as { data: Array<{ id: string }> };
      ok(cached.data.some((m) => m.id === "pollinations:m-alpha"), "cached sweep must not re-fetch");

      const refreshed = (await (await h.client(`${h.base}/v1/models?refresh=1`)).json()) as { data: Array<{ id: string }> };
      ok(!refreshed.data.some((m) => m.id === "pollinations:m-alpha"), "stale row should be gone after refresh");
    } finally {
      await h.close();
      clearModelCatalogCache();
    }
  });
});

describe("serve deny-by-default allowlist", () => {
  /** Empty-allowlist behavior needs a config dir with no allowed-models.json. */
  async function withEmptyAllowlist<T>(fn: () => Promise<T>): Promise<T> {
    const tmp = await mkdtemp(join(os.tmpdir(), "cw-serve-allow-"));
    const prev = process.env["CODEWHIP_CONFIG_DIR"];
    process.env["CODEWHIP_CONFIG_DIR"] = tmp;
    clearModelCatalogCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env["CODEWHIP_CONFIG_DIR"];
      else process.env["CODEWHIP_CONFIG_DIR"] = prev;
      clearModelCatalogCache();
    }
  }

  it("403s every chat request while the allowlist is empty; /v1/models is empty", async () => {
    await withEmptyAllowlist(async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const res = await post(h.base, { model: "kilo:cohere/north-mini-code:free", messages: [{ role: "user", content: "hi" }] });
        strictEqual(res.status, 403);
        const body = (await res.json()) as { error: { code: string; message: string } };
        strictEqual(body.error.code, "model_not_enabled");
        ok(body.error.message.includes("codewhip provider enable"), body.error.message);
        ok(body.error.message.includes("/auth"), "with --auth-ui the message must name the UI");
        ok(body.error.message.includes("/auth#prov-kilo"), "the 403 must deep-link the offending provider's panel");
        const models = (await (await h.client(`${h.base}/v1/models`)).json()) as { data: unknown[] };
        strictEqual(models.data.length, 0);
        // Denial happens before any key resolution or upstream call.
        strictEqual(h.upstream.length, 0);
      } finally {
        await h.close();
      }
    });
  });

  it("the 403 names the CLI when the auth UI is off", async () => {
    await withEmptyAllowlist(async () => {
      const h = await harness({ authUi: false }, () => openAiReply("ok"));
      try {
        const res = await post(h.base, { model: "llm7:default", messages: [{ role: "user", content: "hi" }] });
        strictEqual(res.status, 403);
        const body = (await res.json()) as { error: { message: string } };
        ok(body.error.message.includes("--auth-ui"), body.error.message);
      } finally {
        await h.close();
      }
    });
  });

  it("auto with an empty allowlist resolves to an error that names the remedy", async () => {
    await withEmptyAllowlist(async () => {
      const h = await harness({ provider: "auto", model: "auto" }, () => openAiReply("ok"));
      try {
        const res = await post(h.base, { model: "auto", messages: [{ role: "user", content: "hi" }] });
        strictEqual(res.status, 400);
        const body = (await res.json()) as { error: { message: string } };
        ok(body.error.message.includes("provider enable"), body.error.message);
        strictEqual(h.upstream.length, 0);
      } finally {
        await h.close();
      }
    });
  });

  it("kilo:auto with a real model enabled proxies upstream under that real id", async () => {
    await withEmptyAllowlist(async () => {
      // The stats buffer is a process-wide cache; records from earlier tests
      // would otherwise put non-allowlisted kilo models in the served pool and
      // starve the scoped pick (fresh process = fresh history = default row).
      resetProviderStatsForTest();
      enableEntries(["kilo:cohere/north-mini-code:free"]);
      const h = await harness({}, () => openAiReply("ok"));
      try {
        const res = await post(h.base, { model: "kilo:auto", messages: [{ role: "user", content: "hi" }] });
        const j = (await res.json()) as { serviced_by?: string; error?: { message: string } };
        strictEqual(res.status, 200, JSON.stringify(j));
        strictEqual(h.upstream.length, 1);
        ok(h.upstream[0].body.includes("cohere/north-mini-code:free"), h.upstream[0].body.slice(0, 200));
        strictEqual(j.serviced_by, "kilo:cohere/north-mini-code:free");
      } finally {
        await h.close();
      }
    });
  });

  it("kilo:auto with nothing enabled on kilo is a clear 400 — no upstream probe, no relayed 5xx", async () => {
    await withEmptyAllowlist(async () => {
      // The user's repro: they enabled only the id "auto", then chatted.
      enableEntries(["kilo:auto", "llm7:default"]);
      const h = await harness({}, () => openAiReply("ok"));
      try {
        const res = await post(h.base, { model: "kilo:auto", messages: [{ role: "user", content: "hi" }] });
        strictEqual(res.status, 400);
        const body = (await res.json()) as { error: { message: string } };
        ok(body.error.message.includes('on "kilo"'), body.error.message);
        strictEqual(h.upstream.length, 0);
      } finally {
        await h.close();
      }
    });
  });

  it("an enabled exact id proxies; its provider's other models stay 403", async () => {
    await withEmptyAllowlist(async () => {
      enableEntries(["kilo:cohere/north-mini-code:free"]);
      const h = await harness({}, () => openAiReply("ok"));
      try {
        const ok1 = await post(h.base, { model: "kilo:cohere/north-mini-code:free", messages: [{ role: "user", content: "hi" }] });
        strictEqual(ok1.status, 200);
        strictEqual(h.upstream.length, 1);
        // Same provider, different model — no wildcard, so still refused.
        const denied = await post(h.base, { model: "kilo:some-model", messages: [{ role: "user", content: "hi" }] });
        strictEqual(denied.status, 403);
        strictEqual(h.upstream.length, 1);
      } finally {
        await h.close();
      }
    });
  });

  it("allowlist and capability blocklist compose: consent does not un-block a 410", async () => {
    await withEmptyAllowlist(async () => {
      enableEntries(["kilo:retired-model"]);
      const h = await harness({}, () => new Response("gone", { status: 410 }));
      try {
        const first = await post(h.base, { model: "kilo:retired-model", messages: [{ role: "user", content: "hi" }] });
        ok(first.status >= 400, `first must fail, got ${first.status}`);
        // The 410 was recorded; the second request must refuse WITHOUT
        // touching upstream (blocked by the wire-level gate).
        const second = await post(h.base, { model: "kilo:retired-model", messages: [{ role: "user", content: "hi" }] });
        ok(second.status >= 400, `second must fail, got ${second.status}`);
        const body = (await second.json()) as { error: { message: string } };
        ok(/blocked|retired/i.test(body.error.message), body.error.message);
        strictEqual(h.upstream.length, 1);
      } finally {
        await h.close();
      }
    });
  });
});

describe("auth UI allowlist API", () => {
  /** These tests write allowed-models.json, so they get a throwaway dir. */
  async function withSeededAllowlist<T>(seed: string[], fn: () => Promise<T>): Promise<T> {
    const tmp = await mkdtemp(join(os.tmpdir(), "cw-serve-ui-"));
    const prev = process.env["CODEWHIP_CONFIG_DIR"];
    process.env["CODEWHIP_CONFIG_DIR"] = tmp;
    saveAllowedEntries(seed);
    clearModelCatalogCache();
    try {
      return await fn();
    } finally {
      if (prev === undefined) delete process.env["CODEWHIP_CONFIG_DIR"];
      else process.env["CODEWHIP_CONFIG_DIR"] = prev;
      clearModelCatalogCache();
    }
  }

  type ModelsRow = { id: string; isDefault: boolean; live: boolean; enabled: boolean; recommended: boolean };
  type ModelsBody = { id: string; models: ModelsRow[]; listingError?: string };

  it("GET /auth/_models/<id> merges live catalog ∪ enabled ∪ default; 404 unknown", async () => {
    await withSeededAllowlist(["llm7:default", "llm7:enabled-only", "kilo:some-model"], async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        // Catalog stub: one live model the allowlist has never seen, plus
        // kilo's tracked-$0 default for the recommended-flag assertions.
        const realStub = globalThis.fetch;
        globalThis.fetch = ((url: string, init?: { body?: string }) => {
          if (url.endsWith("/models") || url.endsWith("/models/")) {
            return Promise.resolve(
              new Response(JSON.stringify({ object: "list", data: [{ id: "m-live" }, { id: "cohere/north-mini-code:free" }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            );
          }
          return realStub(url, init);
        }) as unknown as typeof fetch;
        const body = (await (await h.client(`${h.base}/auth/_models/llm7`)).json()) as ModelsBody;
        strictEqual(body.id, "llm7");
        const byId = new Map(body.models.map((m) => [m.id, m]));
        ok(byId.get("default")?.isDefault, "default model must be flagged");
        ok(byId.get("default")?.enabled, "seeded default must read enabled");
        strictEqual(byId.get("enabled-only")?.enabled, true);
        strictEqual(byId.get("enabled-only")?.live, false);
        strictEqual(byId.get("m-live")?.live, true);
        strictEqual(byId.get("m-live")?.enabled, false, "live-but-never-enabled must read disabled");
        strictEqual(byId.get("m-live")?.recommended, false, "untracked price is never recommended");
        const kb = (await (await h.client(`${h.base}/auth/_models/kilo`)).json()) as ModelsBody;
        const kById = new Map(kb.models.map((m) => [m.id, m]));
        strictEqual(kById.get("cohere/north-mini-code:free")?.recommended, true, "tracked $0 live chat model earns ★");
        const missing = await h.client(`${h.base}/auth/_models/ghost-provider`);
        strictEqual(missing.status, 404);
      } finally {
        await h.close();
      }
    });
  });

  it("POST /auth/_starter additively enables the $0 anonymous defaults (capped, idempotent)", async () => {
    await withSeededAllowlist([], async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const first = await h.client(`${h.base}/auth/_starter`, { method: "POST" });
        strictEqual(first.status, 200);
        const b1 = (await first.json()) as { ok: boolean; added: string[]; considered: string[] };
        ok(b1.ok, "starter write reports ok");
        ok(b1.considered.length > 0 && b1.considered.length <= 6, "candidate set is non-empty and capped at 6");
        ok(b1.added.length > 0, "with an empty allowlist the starter must enable something");
        const allowed = new Set(loadAllowedEntries());
        for (const e of b1.added) ok(allowed.has(e), `added entry must land in the allowlist: ${e}`);
        for (const e of b1.considered) ok(!e.endsWith(":auto"), `"auto" is a routing word, never a starter model: ${e}`);
        // Idempotent: the second click adds nothing (enableEntries merges).
        const b2 = (await (await h.client(`${h.base}/auth/_starter`, { method: "POST" })).json()) as { added: string[] };
        strictEqual(b2.added.length, 0, "second starter click must be a no-op");
        strictEqual((await h.client(`${h.base}/auth/_starter`)).status, 405, "GET is not a consent write");
      } finally {
        await h.close();
      }
    });
  });

  it("PUT allowlist replaces one provider's exact ids and takes effect immediately", async () => {
    await withSeededAllowlist(["llm7:default", "llm7:enabled-only", "kilo:some-model"], async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const put = await h.client(`${h.base}/auth/llm7/allowlist`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ models: ["default", "fresh"] }),
        });
        strictEqual(put.status, 200);
        const body = (await put.json()) as { id: string; allowed: string[] };
        deepStrictEqual(body.allowed, ["llm7:default", "llm7:fresh"]);
        const entries = loadAllowedEntries();
        ok(entries.includes("llm7:fresh"), "write must land in allowed-models.json");
        ok(!entries.includes("llm7:enabled-only"), "replaced entry must be gone");
        ok(entries.includes("kilo:some-model"), "other providers must be untouched");
        // Immediate effect on chat, no restart, no cache wait.
        const ok1 = await post(h.base, { model: "llm7:fresh", messages: [{ role: "user", content: "hi" }] });
        strictEqual(ok1.status, 200);
        const gone = await post(h.base, { model: "llm7:enabled-only", messages: [{ role: "user", content: "hi" }] });
        strictEqual(gone.status, 403);
      } finally {
        await h.close();
      }
    });
  });

  it('{"all":true} writes the live catalog\'s exact ids; {"all":false} clears', async () => {
    await withSeededAllowlist(["llm7:stale"], async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const realStub = globalThis.fetch;
        globalThis.fetch = ((url: string, init?: { body?: string }) => {
          if (url.endsWith("/models") || url.endsWith("/models/")) {
            return Promise.resolve(
              new Response(JSON.stringify({ object: "list", data: [{ id: "m-x" }, { id: "m-y" }] }), {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            );
          }
          return realStub(url, init);
        }) as unknown as typeof fetch;
        const all = (await (await h.client(`${h.base}/auth/llm7/allowlist`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ all: true }),
        })).json()) as { allowed: string[] };
        deepStrictEqual(all.allowed, ["llm7:m-x", "llm7:m-y"]);
        // No wildcard was ever written — the file holds exact ids only.
        for (const e of loadAllowedEntries()) ok(!e.endsWith(":*"), `wildcard leaked: ${e}`);
        const none = (await (await h.client(`${h.base}/auth/llm7/allowlist`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ all: false }),
        })).json()) as { allowed: string[] };
        deepStrictEqual(none.allowed, []);
        strictEqual(loadAllowedEntries().length, 0);
      } finally {
        await h.close();
      }
    });
  });

  it("rejects malformed bodies and the retired PATCH toggle", async () => {
    await withSeededAllowlist(["llm7:default"], async () => {
      const h = await harness({ authUi: true }, () => openAiReply("ok"));
      try {
        const bad = await h.client(`${h.base}/auth/llm7/allowlist`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ models: [42] }),
        });
        strictEqual(bad.status, 400);
        strictEqual(((await bad.json()) as { error: { code: string } }).error.code, "invalid_allowlist");
        const wildcard = await h.client(`${h.base}/auth/llm7/allowlist`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ models: ["*"] }),
        });
        strictEqual(wildcard.status, 400, "wildcards must never be writable");
        const patched = await h.client(`${h.base}/auth/llm7`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disabled: true }),
        });
        strictEqual(patched.status, 405, "the provider-level toggle is retired");
      } finally {
        await h.close();
      }
    });
  });
});
