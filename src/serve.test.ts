import { describe, it } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import * as http from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { createServeServer, createShutdown, resolveTarget, startServe, toLoopMessages } from "./serve.js";
import type { ServeOptions } from "./serve.js";
import { PROVIDERS } from "./provider.js";

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
