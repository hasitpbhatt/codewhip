import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChatPort,
  ChatPortResponse,
  LoopMsg,
  LoopToolCall,
  PortFailure,
  RetryableKind,
} from "./provider-port.js";
import { configDir } from "./config-dir.js";
import { recordProviderCall, outcomeForStatus } from "./provider-stats.js";
import { parseRetryAfter, resolveBaseUrl, unresolvedBaseUrlVars } from "./wire-util.js";
import { oneminPort } from "./onemin.js";

/**
 * Builtin provider registry — adding a builtin is ONE table row, nothing else.
 * User-registered providers live outside this file (see custom-providers.ts:
 * `codewhip provider add`) and ride the same OpenAI-compatible ChatPort.
 * The loop only ever sees a ChatPort; openAiPort adapts any config.
 */

/**
 * Registry data (ids, configs, port kinds, timeout bounds) lives in
 * src/provider-registry.ts — a Node-free leaf. src/lib and the Cloudflare
 * worker import it directly; they cannot reach node:fs/path, which this
 * file needs for host pinning and key storage. The re-exports below keep
 * every existing `from "./provider.js"` import working unchanged.
 */
import {
  PROVIDER_IDS,
  PROVIDERS,
  type BuiltinProviderId,
  type ProviderConfig,
} from "./provider-registry.js";
export {
  DEFAULT_CHAT_TIMEOUT_MS,
  MAX_CHAT_TIMEOUT_MS,
  MIN_CHAT_TIMEOUT_MS,
  PROVIDER_IDS,
  PROVIDERS,
  isBuiltinProviderId,
} from "./provider-registry.js";
export type {
  BuiltinProviderId,
  PortKind,
  ProviderConfig,
  ProviderId,
} from "./provider-registry.js";

const MAX_BODY_CHARS = 500;

export function parseProviderId(value: string | undefined): BuiltinProviderId | null {
  return (PROVIDER_IDS as readonly string[]).includes(value ?? "")
    ? (value as BuiltinProviderId)
    : null;
}

/**
 * Placeholder resolution and Retry-After parsing live in ./wire-util.ts so
 * wire adapters can use them without importing this registry back. Re-exported
 * here because callers (models.ts, tests) have always reached for them on this
 * module.
 */
export { parseRetryAfter, resolveBaseUrl, unresolvedBaseUrlVars };

export function chatUrlFor(cfg: ProviderConfig): string {
  return `${resolveBaseUrl(cfg.baseUrl)}${cfg.chatPath}`;
}

export function modelsUrlFor(cfg: ProviderConfig): string {
  return `${resolveBaseUrl(cfg.baseUrl)}${cfg.modelsPath}`;
}

/**
 * Sticky host selection. Some providers serve the API on several hosts but bind
 * a given key to only one (StepFun: keys live on api.stepfun.ai, not
 * api.stepfun.com). We remember the host that last authenticated per provider in
 * `provider-hosts.json` (config dir) so we don't re-probe every call, while
 * still falling back across candidates when a pinned host stops working.
 */
const HOST_OVERRIDE_FILE = "provider-hosts.json";

function loadHostOverride(id: string): string | undefined {
  try {
    const raw = fs.readFileSync(path.join(configDir(), HOST_OVERRIDE_FILE), "utf8");
    const map = JSON.parse(raw) as Record<string, unknown>;
    const v = map[id];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function writeHostOverride(id: string, host: string): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, HOST_OVERRIDE_FILE);
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, string>;
  } catch {
    // fresh or unreadable — start clean
  }
  if (map[id] === host) return;
  map[id] = host;
  fs.writeFileSync(file, JSON.stringify(map) + "\n", { mode: 0o600 });
}

/** Pin `host` as the working base URL for `id` (no-op if it's already primary). */
export function pinHost(id: string, host: string): void {
  writeHostOverride(id, host);
}

/** Ordered base URLs to try: a pinned host first, then primary, then fallbacks. */
export function candidateBaseUrls(cfg: ProviderConfig): string[] {
  const all = [cfg.baseUrl, ...(cfg.fallbackBaseUrls ?? [])];
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const h of all) {
    if (!seen.has(h)) {
      seen.add(h);
      ordered.push(h);
    }
  }
  const pinned = loadHostOverride(cfg.id);
  if (pinned !== undefined && seen.has(pinned)) {
    return [pinned, ...ordered.filter((h) => h !== pinned)];
  }
  return ordered;
}

/**
 * 401/403 message that names the actual culprit source: a stored-file key
 * can silently shadow a keyless free tier (opencode "free" vs anonymous
 * "public", seen 2026-09-14), and "get one at <url>" then sends the user
 * chasing a key they never needed.
 */
export function authHint(cfg: ProviderConfig, keySource?: string): string {
  if (keySource === "file") {
    return `stored ${cfg.id} key was rejected — clear it with "codewhip auth logout ${cfg.id}" (get a fresh one at ${cfg.keyUrl})`;
  }
  if (keySource === "anonymous" && cfg.anonymousKey !== undefined) {
    return `${cfg.brand} rejected the anonymous ${cfg.anonymousKey} key — per-IP quota or tier change; a real key helps (${cfg.keyUrl})`;
  }
  return `invalid or missing ${cfg.envVar} (get one at ${cfg.keyUrl})`;
}

function genericHint(cfg: ProviderConfig, keySource?: string): (status: number, body: string) => string {
  return (status, body) => {
    if (status === 401 || status === 403) {
      return authHint(cfg, keySource);
    }
    if (status === 404 || status === 410) {
      return `unknown or retired model (list live ones via "codewhip models ${cfg.id}"). ${body}`;
    }
    if (status === 429) {
      return `rate limited on ${cfg.brand}${cfg.rateLimitedHint !== undefined ? ` — ${cfg.rateLimitedHint}` : ""}`;
    }
    return `${cfg.brand} api error ${status}. ${body}`;
  };
}

type NvidiaToolCallMsg = {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type NvidiaChatResponse = {
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: Array<NvidiaToolCallMsg> };
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function toWireMessages(messages: LoopMsg[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (m.role === "assistant" && m.toolCalls !== undefined) {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.argsJson },
        })),
      };
    }
    if (m.role === "tool") {
      return { role: "tool", tool_call_id: m.toolCallId ?? "", content: m.content };
    }
    return { role: m.role, content: m.content };
  });
}

function toLoopToolCalls(raw: Array<NvidiaToolCallMsg> | undefined): LoopToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopToolCall[] = [];
  for (const c of raw) {
    const id = typeof c.id === "string" ? c.id : `call_${out.length}`;
    const name = typeof c.function?.name === "string" ? c.function.name : "";
    const argsJson = typeof c.function?.arguments === "string" ? c.function.arguments : "{}";
    if (name.length > 0) {
      out.push({ id, name, argsJson });
    }
  }
  return out;
}

function httpFailure(
  status: number,
  body: string,
  hint: (status: number, body: string) => string,
  res: Response
): PortFailure {
  // 5xx and 408 are transient *server-side* conditions, so rotating to another
  // model or provider is the right move rather than giving up. This matters
  // most for the free chain: free tiers answer 503 under load and during
  // declared maintenance windows, and classifying that as terminal "other"
  // stranded the chain on exactly the failure it exists to survive. 4xx stays
  // terminal — a bad request repeats identically wherever it is sent.
  const retryable: RetryableKind =
    status === 429
      ? "rate-limited"
      : status === 401 || status === 403
        ? "auth"
        : status >= 500 || status === 408
          ? "server"
          : "other";
  const failure: PortFailure = { ok: false, error: hint(status, body), retryable };
  if (retryable === "rate-limited") {
    const wait = parseRetryAfter(res.headers.get("retry-after"));
    if (wait !== undefined) {
      failure.retryAfterMs = wait;
    }
  }
  return failure;
}

/**
 * Idle ceiling once a stream has started delivering bytes. A slow model that
 * is still producing output must not be killed by a total wall clock — only
 * silence means "stalled". The first-byte budget stays the caller's `limit`.
 */
export const SSE_IDLE_TIMEOUT_MS = 45000;
/** Process-level escape hatch (`--no-stream`): force whole-body responses. */
let streamingEnabled = true;
export function setStreamingEnabled(on: boolean): void {
  streamingEnabled = on;
}

type SseAccumulated = {
  text: string;
  toolCalls: LoopToolCall[];
  usage: { prompt: number; completion: number } | null;
};

type SseDeltaToolCall = {
  index?: unknown;
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type SseChunk = {
  choices?: Array<{
    delta?: { content?: unknown; tool_calls?: SseDeltaToolCall[] };
    message?: { content?: unknown; tool_calls?: Array<NvidiaToolCallMsg> };
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

/**
 * Fold one SSE payload into the running result. Content deltas concatenate;
 * tool-call fragments merge by `index` (id/name replace, arguments append —
 * OpenAI streams the arguments as JSON fragments). `message`-shaped chunks are
 * accepted too, for gateways that emit the whole message in one event.
 */
function foldSseChunk(data: string, into: SseAccumulated, acc: Map<number, { id: string; name: string; args: string }>): void {
  let chunk: SseChunk;
  try {
    chunk = JSON.parse(data) as SseChunk;
  } catch {
    return; // keep-alive comments, heartbeats, malformed events
  }
  // != null covers explicit JSON null too: pollinations' anonymous tier can
  // emit `"usage": null` on the budget-exhausted chunk — `null.prompt_tokens`
  // would crash the fold and surface as a mislabeled "network error".
  if (chunk.usage != null) {
    into.usage = { prompt: toCount(chunk.usage.prompt_tokens), completion: toCount(chunk.usage.completion_tokens) };
  }
  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (choice === undefined) return;
  const delta = choice.delta;
  if (delta !== undefined) {
    if (typeof delta.content === "string") into.text += delta.content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        let slot = acc.get(idx);
        if (slot === undefined) {
          slot = { id: "", name: "", args: "" };
          acc.set(idx, slot);
        }
        if (typeof tc.id === "string" && tc.id.length > 0) slot.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name.length > 0) slot.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
      }
    }
    return;
  }
  // Non-delta shape: a complete message in a single event.
  if (choice.message !== undefined) {
    if (typeof choice.message.content === "string") into.text += choice.message.content;
    for (const tc of toLoopToolCalls(choice.message.tool_calls)) into.toolCalls.push(tc);
  }
}

/**
 * Read an SSE body to completion. `armIdle` re-arms the stall watchdog: the
 * caller's first-byte timer is replaced by an idle timer as soon as bytes
 * flow. Errors propagate — the caller classifies them (stalled vs cancelled
 * vs transport) using its own flags, never the rejection's name.
 */
async function readSseStream(res: Response, armIdle: () => void, signal: AbortSignal): Promise<SseAccumulated> {
  const reader = res.body?.getReader();
  if (reader === undefined) {
    throw new Error("stream body unavailable");
  }
  const decoder = new TextDecoder();
  const into: SseAccumulated = { text: "", toolCalls: [], usage: null };
  const acc = new Map<number, { id: string; name: string; args: string }>();
  let buf = "";
  let sawDone = false;
  const drain = (final: boolean): void => {
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl === -1) break;
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") {
        sawDone = true;
        return;
      }
      if (payload.length > 0) foldSseChunk(payload, into, acc);
    }
    if (final && buf.trim().length > 0) {
      const line = buf.trim();
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload !== "[DONE]" && payload.length > 0) foldSseChunk(payload, into, acc);
      }
    }
  };
  try {
    for (;;) {
      if (signal.aborted) break;
      // The caller's first-byte budget is still armed while we await the
      // first chunk; only once bytes arrive does silence become "stalled".
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) buf += decoder.decode(value, { stream: true });
      armIdle();
      drain(false);
      if (sawDone) break;
    }
    drain(true);
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
  // Tool calls are assembled from fragments only after the stream ends —
  // this must run on every exit path, [DONE] included.
  for (const [idx, slot] of [...acc.entries()].sort((a, b) => a[0] - b[0])) {
    if (slot.name.length > 0) {
      into.toolCalls.push({ id: slot.id.length > 0 ? slot.id : `call_${idx}`, name: slot.name, argsJson: slot.args.length > 0 ? slot.args : "{}" });
    }
  }
  return into;
}

/** chars/4 fallback when a stream ends without a usage block. Labelled "est.". */
function estimateUsage(bodyChars: number, text: string, toolCalls: LoopToolCall[]): { prompt: number; completion: number } {
  let out = text.length;
  for (const c of toolCalls) out += c.name.length + c.argsJson.length;
  return { prompt: Math.ceil(bodyChars / 4), completion: Math.ceil(out / 4) };
}

function openAiPort(cfg: ProviderConfig, apiKey: string, timeoutMs?: number, keySource?: string): ChatPort {
  const brand = cfg.brand;
  const hint = genericHint(cfg, keySource);
  const limit = timeoutMs ?? cfg.timeoutMs;
  /**
   * Once this provider is seen rejecting a streaming body, stop paying the
   * failed round-trip on every later call. Scoped to the port (one run), not
   * the process, so a single bad call cannot disable streaming globally.
   */
  let streamUnsupported = false;
  return async ({ model, messages, tools, signal }): Promise<ChatPortResponse> => {
    if (apiKey.length === 0) {
      return { ok: false, error: "missing api key", retryable: "other" };
    }
    // Fail loudly on an account-scoped base URL whose id env var is unset:
    // otherwise the empty path segment turns into a confusing 404 that reads
    // as "unknown model".
    const missingVars = unresolvedBaseUrlVars(cfg.baseUrl);
    if (missingVars.length > 0) {
      return { ok: false, error: `${brand} needs ${missingVars.join(", ")} set (account-scoped base url)`, retryable: "other" };
    }
    if (model.length === 0 || model.length > 200) {
      return { ok: false, error: "bad model id (empty or >200 chars)", retryable: "other" };
    }
    const ctrl = new AbortController();
    // Classify our own timeouts by these flags, never by the rejection's
    // `name`: aborting with a custom reason makes fetch reject with that
    // reason object (name "Error"), so name-sniffing read every timer expiry
    // as a network failure — typed non-retryable, bypassing rotation.
    let timedOut = false;
    let stalled = false;
    // A caller-supplied budget bounds the whole call, so the idle window may
    // never exceed it: `--timeout-ms 5000` must mean 5s, not 45s of silence.
    const idle = Math.min(SSE_IDLE_TIMEOUT_MS, limit);
    // First-byte budget for the whole call; replaced by the idle watchdog
    // once a stream starts delivering bytes.
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, limit);
    const clearTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    const armIdle = (): void => {
      clearTimer();
      timer = setTimeout(() => {
        stalled = true;
        ctrl.abort();
      }, idle);
    };
    const onAbort = (): void => ctrl.abort(signal?.reason);
    try {
      if (signal !== undefined) {
        if (signal.aborted) {
          return { ok: false, error: "cancelled", retryable: "other" };
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const wireHeaders: Record<string, string> = {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      if (cfg.headers !== undefined) {
        Object.assign(wireHeaders, cfg.headers);
      }
      const wireMessages = toWireMessages(messages);
      const wireTools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      const buildBody = (useStream: boolean): string =>
        JSON.stringify({
          model,
          messages: wireMessages,
          tools: wireTools,
          stream: useStream,
          ...(useStream ? { stream_options: { include_usage: true } } : {}),
        });
      const wantStream = streamingEnabled && !streamUnsupported;
      // Try each candidate host; fall back to the next only on auth rejection.
      const hosts = candidateBaseUrls(cfg);
      let lastFailure: PortFailure | null = null;
      for (let i = 0; i < hosts.length; i++) {
        const url = `${resolveBaseUrl(hosts[i])}${cfg.chatPath}`;
        let useStream = wantStream;
        let attempts = 0;
        // One streaming attempt, then at most one non-streaming retry on the
        // same host when the provider turns out not to support streaming.
        for (;;) {
          attempts += 1;
          const callStart = Date.now();
          const body = buildBody(useStream);
          let res: Response;
          try {
            res = await fetch(url, { method: "POST", headers: wireHeaders, body, signal: ctrl.signal });
          } catch (err) {
            if (signal?.aborted === true) {
              return { ok: false, error: "cancelled", retryable: "other" };
            }
            if (stalled) {
              recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "timeout", host: hosts[i], ms: Date.now() - callStart, error: "stream stalled" });
              return { ok: false, error: `${brand} api stream stalled (no data for ${idle}ms)`, retryable: "timeout" };
            }
            const name = err instanceof Error ? err.name : "";
            if (timedOut || name === "TimeoutError" || name === "AbortError") {
              recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "timeout", host: hosts[i], ms: Date.now() - callStart });
              return { ok: false, error: `${brand} api timed out after ${limit}ms`, retryable: "timeout" };
            }
            const netErr = `network error on ${hosts[i]}: ${err instanceof Error ? err.message : "fetch failed"}`;
            if (i < hosts.length - 1) {
              // transient transport failure on this host; let the next host try
              lastFailure = { ok: false, error: netErr, retryable: "other" };
              break;
            }
            recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "network", host: hosts[i], ms: Date.now() - callStart, error: netErr.slice(0, 120) });
            return { ok: false, error: netErr, retryable: "other" };
          }
          const ms = Date.now() - callStart;
          if (res.ok) {
            // Pin the working host so subsequent calls skip the dead one.
            if (hosts[i] !== cfg.baseUrl) {
              pinHost(cfg.id, hosts[i]);
            }
            const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");
            if (useStream && isSse) {
              let parsed: SseAccumulated;
              try {
                parsed = await readSseStream(res, armIdle, ctrl.signal);
              } catch (err) {
                if (signal?.aborted === true) {
                  return { ok: false, error: "cancelled", retryable: "other" };
                }
                if (stalled) {
                  recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "timeout", host: hosts[i], ms: Date.now() - callStart, error: "stream stalled" });
                  return { ok: false, error: `${brand} api stream stalled (no data for ${idle}ms)`, retryable: "timeout" };
                }
                if (timedOut) {
                  recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "timeout", host: hosts[i], ms: Date.now() - callStart });
                  return { ok: false, error: `${brand} api timed out after ${limit}ms`, retryable: "timeout" };
                }
                // A stream that dies mid-flight is a transport failure.
                const netErr = `network error on ${hosts[i]}: ${err instanceof Error ? err.message : "stream failed"}`;
                recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "network", host: hosts[i], ms: Date.now() - callStart, error: netErr.slice(0, 120) });
                return { ok: false, error: netErr, retryable: "other" };
              }
              if (parsed.text.length > 0 || parsed.toolCalls.length > 0) {
                const estimated = parsed.usage === null;
                const usage = parsed.usage ?? estimateUsage(body.length, parsed.text, parsed.toolCalls);
                // Stats carry only meter readings: an estimate never enters
                // provider-analytics (receipts mark it "est." instead).
                recordProviderCall({
                  ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "ok", host: hosts[i], status: res.status, ms: Date.now() - callStart,
                  ...(parsed.usage !== null ? { promptTokens: usage.prompt, completionTokens: usage.completion } : {}),
                });
                return {
                  ok: true,
                  text: parsed.text.length > 0 ? parsed.text : null,
                  toolCalls: parsed.toolCalls,
                  promptTokens: usage.prompt,
                  completionTokens: usage.completion,
                  usageEstimated: estimated,
                };
              }
              // Stream opened but carried nothing usable: this gateway does
              // not really stream. Remember it and retry without streaming.
              streamUnsupported = true;
              if (attempts < 2) {
                useStream = false;
                continue;
              }
              return { ok: false, error: `${brand} api returned no text or tool calls`, retryable: "other" };
            }
            let data: NvidiaChatResponse;
            try {
              data = (await res.json()) as NvidiaChatResponse;
            } catch {
              return { ok: false, error: `${brand} api returned invalid JSON`, retryable: "other" };
            }
            const msg = Array.isArray(data.choices) ? data.choices[0]?.message : undefined;
            const content = typeof msg?.content === "string" ? msg.content : null;
            const toolCalls = toLoopToolCalls(msg?.tool_calls);
            if ((content === null || content.length === 0) && toolCalls.length === 0) {
              return { ok: false, error: `${brand} api returned no text or tool calls`, retryable: "other" };
            }
            const prompt = toCount(data.usage?.prompt_tokens);
            const completion = toCount(data.usage?.completion_tokens);
            recordProviderCall({
              ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "ok", host: hosts[i], status: res.status, ms,
              ...(data.usage !== undefined ? { promptTokens: prompt, completionTokens: completion } : {}),
            });
            return {
              ok: true,
              text: content,
              toolCalls,
              promptTokens: prompt,
              completionTokens: completion,
            };
          }
          let respBody = "";
          try {
            respBody = (await res.text()).slice(0, MAX_BODY_CHARS);
          } catch {
            respBody = "";
          }
          const failure = httpFailure(res.status, respBody, hint, res);
          // A gateway that rejects the streaming body (400/422) gets one
          // immediate non-streaming retry before the status is believed.
          if (useStream && (res.status === 400 || res.status === 422) && attempts < 2) {
            streamUnsupported = true;
            useStream = false;
            continue;
          }
          const outcome = outcomeForStatus(res.status);
          // Retry a sibling host only on auth rejection; other statuses are
          // authoritative (402 quota, 429 rate-limit, 404 model, 5xx).
          if ((res.status === 401 || res.status === 403) && i < hosts.length - 1) {
            lastFailure = failure;
            break;
          }
          recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome, host: hosts[i], status: res.status, ms, error: respBody.slice(0, 120) });
          return failure;
        }
      }
      return lastFailure ?? { ok: false, error: `${brand} api error (no host reachable)`, retryable: "other" };
    } catch (err) {
      if (signal !== undefined && signal.aborted) {
        return { ok: false, error: "cancelled", retryable: "other" };
      }
      if (stalled) {
        return { ok: false, error: `${brand} api stream stalled (no data for ${idle}ms)`, retryable: "timeout" };
      }
      const name = err instanceof Error ? err.name : "";
      if (timedOut || name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `${brand} api timed out after ${limit}ms`, retryable: "timeout" };
      }
      return { ok: false, error: `network error: ${err instanceof Error ? err.message : "fetch failed"}`, retryable: "other" };
    } finally {
      clearTimer();
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Tool-calling adapter for an explicit config (builtins and customs alike). */
export function makePortForConfig(cfg: ProviderConfig, apiKey: string, timeoutMs?: number, keySource?: string): ChatPort {
  // One branch, keyed by the row's own discriminator — a non-OpenAI provider
  // never has to be special-cased by id at every call site.
  return cfg.port === "onemin" ? oneminPort(cfg, apiKey, timeoutMs, keySource) : openAiPort(cfg, apiKey, timeoutMs, keySource);
}

/** Tool-calling adapter implementing the loop's ChatPort for a builtin provider. */
export function makePort(provider: string, apiKey: string, timeoutMs?: number): ChatPort {
  const cfg = PROVIDERS[provider as BuiltinProviderId];
  if (cfg === undefined) {
    return async () => ({ ok: false, error: `unknown provider: ${provider}`, retryable: "other" });
  }
  return openAiPort(cfg, apiKey, timeoutMs);
}