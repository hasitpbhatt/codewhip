import * as http from "node:http";
import { randomUUID } from "node:crypto";
import { getProviderConfig, listAllProviderConfigs } from "./custom-providers.js";
import { makePortForConfig } from "./provider.js";
import { resolveKey } from "./auth.js";
import type { LoopMsg, LoopToolCall, ToolSpec } from "./provider-port.js";

/**
 * `codewhip serve` — expose the provider registry as an OpenAI-compatible HTTP
 * server, so any OpenAI client (or another agent framework) can use the whole
 * registry — every builtin, custom provider, and translating port (1min) —
 * without knowing anything about them. Deliberately no count here: a hardcoded
 * one is what goes stale the next time a provider is added.
 *
 * Two deliberate design choices:
 *
 * 1. **The client always gets the OpenAI streaming contract.** Even when the
 *    upstream is non-streaming — 1min's port never streams, and `--no-stream`
 *    disables SSE globally — the server synthesizes a well-formed SSE stream
 *    from the whole response. A client that asked for `stream: true` never has
 *    to know which upstream it landed on.
 *
 * 2. **Loopback by default, and loud about it.** This process spends your API
 *    keys on behalf of whoever can reach the port. It binds 127.0.0.1 unless
 *    told otherwise, and refuses to bind a non-loopback address without a
 *    `--token`. The refusal is the point: an open proxy holding your keys is
 *    exactly the failure mode this project exists to avoid.
 *
 * `serve` is a provider proxy, NOT an agent run: it executes no tools, applies
 * no policy, and writes no audit entries (there are no tool calls to record).
 * It does record provider-analytics like any other provider call. The client
 * owns tool execution and therefore owns its own safety story.
 */

const MAX_BODY_BYTES = 4 * 1024 * 1024;

export type ServeOptions = {
  port: number;
  host: string;
  /** Provider used when the requested model has no `provider:` prefix. */
  provider: string;
  /** Model used when the request names none. */
  model: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
};

type OpenAiMessage = {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
};

type OpenAiRequest = {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
  stream_options?: unknown;
};

type Target = { provider: string; model: string };

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** OpenAI `tools[]` → the loop's ToolSpec. Names pass through verbatim. */
function toToolSpecs(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolSpec[] = [];
  for (const entry of raw) {
    const fn = (entry as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (name.length === 0) continue;
    out.push({
      // ToolSpec.name is codewhip's own ToolName union; a proxy must forward
      // whatever the client called its tools, so the narrowing is a
      // compile-time convenience only — nothing here resolves a tool by name.
      name: name as ToolSpec["name"],
      description: typeof fn?.description === "string" ? fn.description : "",
      parameters: fn?.parameters ?? { type: "object", properties: {} },
    });
  }
  return out;
}

function toLoopToolCalls(raw: unknown): LoopToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopToolCall[] = [];
  for (const entry of raw) {
    const c = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof c?.function?.name === "string" ? c.function.name : "";
    if (name.length === 0) continue;
    const args = c.function?.arguments;
    out.push({
      id: typeof c.id === "string" && c.id.length > 0 ? c.id : `call_${out.length}`,
      name,
      argsJson: typeof args === "string" && args.length > 0 ? args : "{}",
    });
  }
  return out;
}

/** OpenAI `messages[]` → the loop's LoopMsg. Non-string content is flattened. */
export function toLoopMessages(raw: unknown): LoopMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopMsg[] = [];
  for (const entry of raw) {
    const m = entry as OpenAiMessage;
    const role = m?.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? contentToText(m.content) : "";
    if (role === "tool") {
      out.push({ role: "tool", content, toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = toLoopToolCalls(m.tool_calls);
      out.push(toolCalls.length > 0 ? { role, content, toolCalls } : { role, content });
      continue;
    }
    out.push({ role, content });
  }
  return out;
}

/** OpenAI content-part arrays (`[{type:"text",text:"…"}]`) → one string. */
function contentToText(parts: unknown[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as { type?: unknown; text?: unknown };
    if (p?.type === "text" && typeof p.text === "string") chunks.push(p.text);
  }
  return chunks.join("");
}

/**
 * Resolve the `model` field. `provider:model` wins (split at the FIRST colon —
 * model ids legitimately contain colons, e.g. `kilo:cohere/north-mini-code:free`),
 * a bare provider id means "that provider's default model", anything else is a
 * model id on the server's default provider.
 */
export function resolveTarget(requested: string, fallback: { provider: string; model: string }): Target | { error: string } {
  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    return { provider: fallback.provider, model: fallback.model };
  }
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const provider = trimmed.slice(0, colon);
    const model = trimmed.slice(colon + 1);
    if (getProviderConfig(provider) === null) return { error: `unknown provider "${provider}"` };
    if (model.length === 0) return { error: `missing model id after "${provider}:"` };
    return { provider, model };
  }
  const asProvider = getProviderConfig(trimmed);
  if (asProvider !== null) {
    return { provider: asProvider.id, model: asProvider.defaultModel };
  }
  if (getProviderConfig(fallback.provider) === null) {
    return { error: `unknown default provider "${fallback.provider}"` };
  }
  return { provider: fallback.provider, model: trimmed };
}

function statusForError(retryable: string): number {
  if (retryable === "auth") return 401;
  if (retryable === "rate-limited") return 429;
  if (retryable === "timeout") return 504;
  // An upstream 5xx is relayed as 502 (bad gateway): the failure is the
  // upstream's, not this server's and not the client's request.
  if (retryable === "server") return 502;
  return 502;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string, code = "provider_error"): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code } });
}

function readBody(req: http.IncomingMessage): Promise<string | { error: string }> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve({ error: "request body too large" });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve({ error: "failed to read request body" }));
  });
}

/** One `choices[0]` entry in OpenAI's non-streaming shape. */
function completionChoice(text: string | null, toolCalls: LoopToolCall[]): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: text };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((c, i) => ({
      index: i,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.argsJson },
    }));
  }
  return { index: 0, message, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" };
}

/**
 * Synthesize a complete OpenAI SSE stream from a whole response. This is what
 * lets a non-streaming upstream (1min, or any provider after `--no-stream`)
 * still satisfy a client that asked to stream.
 */
function writeSyntheticStream(
  res: http.ServerResponse,
  id: string,
  model: string,
  created: number,
  text: string | null,
  toolCalls: LoopToolCall[],
  usage: { prompt: number; completion: number },
  includeUsage: boolean
): void {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  res.write(chunk({ role: "assistant" }, null));
  if (text !== null && text.length > 0) {
    res.write(chunk({ content: text }, null));
  }
  if (toolCalls.length > 0) {
    res.write(
      chunk(
        {
          tool_calls: toolCalls.map((c, i) => ({
            index: i,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.argsJson },
          })),
        },
        null
      )
    );
  }
  res.write(chunk({}, toolCalls.length > 0 ? "tool_calls" : "stop"));
  if (includeUsage) {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [],
        usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
      })}\n\n`
    );
  }
  res.write("data: [DONE]\n\n");
}

function modelList(): Record<string, unknown> {
  const created = Math.floor(Date.now() / 1000);
  const rows = listAllProviderConfigs().map((cfg) => ({
    id: `${cfg.id}:${cfg.defaultModel}`,
    object: "model",
    created,
    owned_by: cfg.id,
  }));
  return { object: "list", data: rows };
}

export function createServeHandler(opts: ServeOptions): http.RequestListener {
  return (req, res): void => {
    void handle(req, res, opts);
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: ServeOptions): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    sendJson(res, 200, { status: "ok", providers: listAllProviderConfigs().length });
    return;
  }
  if (opts.token !== undefined) {
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${opts.token}`) {
      sendError(res, 401, "missing or invalid bearer token for this server", "invalid_api_key");
      return;
    }
  }
  if (req.method === "GET" && path === "/v1/models") {
    sendJson(res, 200, modelList());
    return;
  }
  if (req.method !== "POST" || path !== "/v1/chat/completions") {
    sendError(res, 404, `unknown route ${req.method ?? ""} ${path} (try /v1/chat/completions, /v1/models, /health)`, "not_found");
    return;
  }
  const raw = await readBody(req);
  if (typeof raw === "object") {
    sendError(res, 413, raw.error, "request_too_large");
    return;
  }
  let parsed: OpenAiRequest;
  try {
    parsed = JSON.parse(raw) as OpenAiRequest;
  } catch {
    sendError(res, 400, "request body is not valid JSON", "invalid_json");
    return;
  }
  const requested = typeof parsed.model === "string" ? parsed.model : "";
  const target = resolveTarget(requested, { provider: opts.provider, model: opts.model });
  if ("error" in target) {
    sendError(res, 400, target.error, "unknown_provider");
    return;
  }
  const cfg = getProviderConfig(target.provider);
  if (cfg === null) {
    sendError(res, 400, `unknown provider "${target.provider}"`, "unknown_provider");
    return;
  }
  const messages = toLoopMessages(parsed.messages);
  if (messages.length === 0) {
    sendError(res, 400, "messages[] is required and must not be empty", "invalid_messages");
    return;
  }
  const key = resolveKey(target.provider);
  if (key.key.length === 0) {
    sendError(res, 401, `no key for "${target.provider}" — set ${cfg.envVar} or run: codewhip auth login ${target.provider}`, "missing_provider_key");
    return;
  }
  const stream = parsed.stream === true;
  const includeUsage =
    typeof parsed.stream_options === "object" &&
    parsed.stream_options !== null &&
    (parsed.stream_options as { include_usage?: unknown }).include_usage === true;
  const port = makePortForConfig(cfg, key.key);
  const result = await port({ model: target.model, messages, tools: toToolSpecs(parsed.tools) });
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!result.ok) {
    sendError(res, statusForError(result.retryable), result.error, result.retryable);
    return;
  }
  const usage = { prompt: result.promptTokens, completion: result.completionTokens };
  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeSyntheticStream(res, id, target.model, created, result.text, result.toolCalls, usage, includeUsage);
    res.end();
    return;
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: target.model,
    choices: [completionChoice(result.text, result.toolCalls)],
    usage: {
      prompt_tokens: usage.prompt,
      completion_tokens: usage.completion,
      total_tokens: usage.prompt + usage.completion,
      // Honest about provenance: an estimate is not a meter reading.
      ...(result.usageEstimated === true ? { estimated: true } : {}),
    },
  });
}

/** Build the server without listening — exported so tests can drive it. */
export function createServeServer(opts: ServeOptions): http.Server {
  return http.createServer(createServeHandler(opts));
}

export type ShutdownController = {
  /** Signal handler. Safe to call any number of times. */
  shutdown: () => void;
  isShuttingDown: () => boolean;
};

/**
 * Graceful stop, in one place so it can be tested.
 *
 * Two defects this exists to prevent, both of which produce the *same*
 * confusing symptom — `MaxListenersExceededWarning: 11 close listeners added
 * to [Server]` — followed by a process that appears to ignore Ctrl-C:
 *
 * 1. `server.close()` is not idempotent: every call adds another 'close'
 *    listener, and the 11th trips Node's warning. A naive signal handler that
 *    calls close() on every SIGINT leaks a listener per keypress.
 * 2. `server.close()` waits for existing connections to finish, and an idle
 *    HTTP keep-alive socket never finishes — so the process hangs, the
 *    operator presses Ctrl-C again, and defect 1 fires. `closeIdleConnections()`
 *    is what actually makes this exit.
 *
 * A second signal is treated as "the operator is impatient" and exits
 * immediately, rather than being swallowed or stacking another listener.
 */
export function createShutdown(server: http.Server, exit: (code: number) => void, graceMs = 5000): ShutdownController {
  let shuttingDown = false;
  return {
    isShuttingDown: () => shuttingDown,
    shutdown: () => {
      if (shuttingDown) {
        exit(0);
        return;
      }
      shuttingDown = true;
      server.close(() => exit(0));
      // Drop sockets that are merely idle: they would otherwise hold the
      // process open forever, because keep-alive has no natural end.
      server.closeIdleConnections();
      // A stuck in-flight request must not make the process unkillable.
      const force = setTimeout(() => exit(0), graceMs);
      force.unref();
    },
  };
}

export function startServe(opts: ServeOptions): http.Server {
  if (!isLoopback(opts.host) && opts.token === undefined) {
    throw new Error(
      `refusing to bind ${opts.host} without --token: this server spends your provider keys on behalf of anyone who can reach it. Add --token <secret>, or bind 127.0.0.1.`
    );
  }
  const server = createServeServer(opts);
  // Without this, a busy port surfaces as an unhandled 'error' event and a raw
  // stack trace instead of something a human can act on.
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`serve: port ${opts.port} is already in use — pick another with --port`);
    } else {
      console.error(`serve: ${err.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(opts.port, opts.host, () => {
    const addr = server.address();
    const shown = typeof addr === "object" && addr !== null ? `${addr.address}:${addr.port}` : `${opts.host}:${opts.port}`;
    console.log(`codewhip serve — OpenAI-compatible endpoint on http://${shown}`);
    console.log(`  POST /v1/chat/completions   (stream and non-stream; model = "<provider>:<model>")`);
    console.log(`  GET  /v1/models             (${listAllProviderConfigs().length} providers as "<provider>:<default-model>")`);
    console.log(`  GET  /health`);
    console.log(`  default route: ${opts.provider}:${opts.model}`);
    console.log(`  auth: ${opts.token !== undefined ? "bearer token required" : "none (loopback only)"}`);
    console.log(`  note: this proxies models — it runs no tools, applies no policy, and writes no audit entries.`);
    console.log(`  stop with Ctrl-C (press again to force).`);
  });
  return server;
}
