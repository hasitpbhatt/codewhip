import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { addCustomProvider, getProviderConfig, isLoopbackBaseUrl, listAllProviderConfigs, removeCustomProvider, listAllProviderConfigsWithDisabled } from "./custom-providers.js";
import { isBuiltinProviderId, makePortForConfig, PROVIDERS, type ProviderId } from "./provider.js";
import { resolveKey, saveKey, clearKey } from "./auth.js";
import type { ChatPortResponse, LoopMsg, LoopToolCall, ToolSpec } from "./provider-port.js";
import { LISTING_MODEL, readProviderCalls, summarizeCalls } from "./provider-stats.js";
import { estimateCost, healthPasses, healthRate, isAutoEligible, TTL_MS } from "./router.js";
import { listModels } from "./models.js";
import { FREE_CHAIN } from "./free-chain.js";
import { allowedModelsFor, enableEntries, isModelAllowed, loadAllowedEntries, parseEntry, providerIsEnabled, setProviderAllowlist } from "./model-allowlist.js";

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
  /** Serve the provider key manager UI (HTML + JSON API); off by default. */
  authUi?: boolean;
  /** When true, /v1/models only lists providers that respond to their models endpoint. */
  pingModels?: boolean;
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

/**
 * Constant-time bearer comparison. Length check first (timingSafeEqual
 * throws on unequal lengths) — a length mismatch is a mismatch, full stop.
 */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined) return false;
  const want = `Bearer ${token}`;
  if (header.length !== want.length) return false;
  return timingSafeEqual(Buffer.from(header, "utf8"), Buffer.from(want, "utf8"));
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
 * model id on the server's default provider. `auto` is a routing word, never an
 * upstream model id: bare `auto` health-weights across every enabled model,
 * and `provider:auto` narrows the same pick to that provider.
 */
/**
 * Health-weighted auto pick for `model: "auto"` (and `--provider auto`).
 * Eligibility (loopback / key / paid-key gates) is `isAutoEligible` in the
 * router — one rule for CLI and serve, so a paid key is never auto-touched.
 * On top: TTL deactivation plus the shared health gate (`healthPasses` —
 * recency-windowed rate, staleness reset after 24h of silence so a failed
 * model is re-probed instead of ratcheted out forever), then weight drains
 * the known-$0 pool first: free ×3, priced ×1, untracked ×0.5 (opt-in only),
 * times (0.5 + recency-aware successRate) so a proven model beats an
 * unproven one without starving new providers. The weighting is serve's
 * exploration: a gated model that re-enters picks at reduced probability.
 * No-data providers keep full weight — empty history is not failure.
 */
function pickAutoTarget(exclude?: ReadonlySet<string>, onlyProvider?: string): Target | { error: string } {
  const summary = summarizeCalls(readProviderCalls());
  const cands: Array<{ provider: string; model: string; weight: number }> = [];
  for (const cfg of listAllProviderConfigs()) {
    // `provider:auto` narrows the pool to one provider; bare auto stays global.
    if (onlyProvider !== undefined && cfg.id !== onlyProvider) continue;
    // Consent gate first: auto may only pick explicitly enabled models.
    if (!providerIsEnabled(cfg.id)) continue;
    if (!isAutoEligible(cfg.id, cfg.defaultModel)) continue;
    // Cooling is per-MODEL, not per-provider: a failing model is skipped, but
    // other models from the same provider stay eligible — auto can still try a
    // different model there unless every model is cooling. Only when a provider
    // reports NO served models at all do we fall back to its default model.
    // Listing probes ((listing) records from the /v1/models sweep) are checks,
    // not models — they must not crowd the default out of the pool.
    const served = (summary.providers.find((p) => p.provider === cfg.id)?.models ?? [])
      .filter((m) => m.model !== LISTING_MODEL);
    const modelIds = served.length > 0 ? served.map((m) => m.model) : [cfg.defaultModel];
    for (const modelId of modelIds) {
      // "auto" is a routing word, not a model — never a candidate, even if an
      // old allowlist file still carries a `<provider>:auto` entry.
      if (modelId === "auto") continue;
      if (!isModelAllowed(cfg.id, modelId)) continue;
      if (exclude !== undefined && exclude.has(`${cfg.id}:${modelId}`)) continue;
      const mh = served.find((m) => m.model === modelId);
      // TTL deactivation against the summary computed above — one pass over the
      // records per request, not one per candidate (isRecentlyFailed re-reads).
      if (
        mh !== undefined && mh.lastFailureTs !== undefined && mh.lastFailureOutcome !== undefined &&
        mh.lastFailureOutcome !== "ok"
      ) {
        const ttl = TTL_MS[mh.lastFailureOutcome] ?? 5 * 60_000;
        if (Date.now() - new Date(mh.lastFailureTs).getTime() < ttl) continue;
      }
      if (mh !== undefined && !healthPasses(mh, 0.5)) continue;
      const per1k = estimateCost(cfg.id as ProviderId, modelId, 1000, 1000);
      const costFactor = per1k === null ? 0.5 : per1k === 0 ? 3 : 1;
      const healthFactor = mh === undefined ? 1.5 : 0.5 + healthRate(mh);
      cands.push({ provider: cfg.id, model: modelId, weight: costFactor * healthFactor });
    }
  }
  if (cands.length === 0) {
    if (onlyProvider !== undefined) {
      return { error: `${onlyProvider}:auto — no healthy enabled models on "${onlyProvider}" right now: enable at least one real model id at /auth (or \`codewhip provider enable ${onlyProvider}:<model>\`), or use bare "auto" to health-pick across all providers` };
    }
    return { error: "auto: no enabled healthy provider/model combos available — enable models at /auth or run: codewhip provider enable <provider>:<model>, or pass an explicit model (a $0 route also needs health: set CODEWHIP_AUTO_INCLUDE_UNTRACKED=1 to let auto use untracked-cost providers)" };
  }
  const total = cands.reduce((a, c) => a + c.weight, 0);
  let r = Math.random() * total;
  for (const c of cands) {
    r -= c.weight;
    if (r <= 0) return { provider: c.provider, model: c.model };
  }
  const last = cands[cands.length - 1] as { provider: string; model: string };
  return { provider: last.provider, model: last.model };
}

export function resolveTarget(requested: string, fallback: { provider: string; model: string }): Target | { error: string } {
  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    if (fallback.provider === "auto") return pickAutoTarget();
    return { provider: fallback.provider, model: fallback.model };
  }
  if (trimmed === "auto") {
    return pickAutoTarget();
  }
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const provider = trimmed.slice(0, colon);
    const model = trimmed.slice(colon + 1);
    if (getProviderConfig(provider) === null) return { error: `unknown provider "${provider}"` };
    if (model.length === 0) return { error: `missing model id after "${provider}:"` };
    // `<provider>:auto` = auto-pick scoped to that provider. Without this
    // intercept the word "auto" would ship upstream as a literal model id.
    if (model === "auto") return pickAutoTarget(undefined, provider);
    return { provider, model };
  }
  const asProvider = getProviderConfig(trimmed);
  if (asProvider !== null) {
    return { provider: asProvider.id, model: asProvider.defaultModel };
  }
  if (fallback.provider === "auto") {
    // `--provider auto` with a pinned model id: pick the provider, keep the id.
    const pick = pickAutoTarget();
    if ("error" in pick) return pick;
    return { provider: pick.provider, model: trimmed };
  }
  if (getProviderConfig(fallback.provider) === null) {
    return { error: `unknown default provider "${fallback.provider}"` };
  }
  return { provider: fallback.provider, model: trimmed };
}

/**
 * Silent-retry bound for fully-auto chat requests: 1 initial pick + 2 quiet
 * hops across distinct provider:model targets. Bounds fault-storm latency;
 * explicit-model requests never retry (pinned = consent to that target).
 */
const AUTO_ATTEMPTS = 3;

function statusForError(retryable: string): number {  if (retryable === "auth") return 401;
  if (retryable === "rate-limited") return 429;
  if (retryable === "timeout") return 504;
  // An upstream 5xx is relayed as 502 (bad gateway): the failure is the
  // upstream's, not this server's and not the client's request.
  if (retryable === "server") return 502;
  return 502;
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers?: Record<string, string>): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), ...headers });
  res.end(body);
}

function sendError(res: http.ServerResponse, status: number, message: string, code = "provider_error", headers?: Record<string, string>): void {
  sendJson(res, status, { error: { message, type: "invalid_request_error", code } }, headers);
}

/**
 * Fire-and-forget server-side logging. Never awaited and never in the request
 * path, so it cannot add latency to the client's response: the call returns
 * immediately and the work (fs/console) runs on the next tick. Used to surface
 * turn/provider failures on the operator's terminal without holding the
 * response hostage to disk I/O.
 */
function logErrorLazy(label: string, detail: string): void {
  setImmediate(() => {
    try {
      // eslint-disable-next-line no-console
      console.error(`[serve] ${label}: ${detail}`);
    } catch {
      /* logging must never throw into the request path */
    }
  });
}

/**
 * Fixed-window per-IP cap guarding the key-spending endpoint: `limit`
 * requests per `windowMs`; over-limit gets 429 + Retry-After. Dependency-free
 * on purpose — this process spends real keys, so the guard itself adds no
 * supply-chain surface. Buckets are lazy-swept; a request from an IP whose
 * window expired starts a fresh one. X-Forwarded-For is deliberately ignored
 * (spoofable, and the server binds loopback by default anyway).
 */
export class IpRateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private limit = 30,
    private windowMs = 60_000,
    private maxBuckets = 10_000
  ) {}

  check(ip: string, now = Date.now()): { admitted: true } | { admitted: false; retryAfterSec: number } {
    const bucket = this.buckets.get(ip);
    if (bucket === undefined || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return { admitted: true };
    }
    if (bucket.count >= this.limit) {
      return { admitted: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    bucket.count += 1;
    return { admitted: true };
  }

  private sweep(now: number): void {
    if (this.buckets.size <= this.maxBuckets) return;
    for (const [ip, bucket] of this.buckets) {
      if (now >= bucket.resetAt) this.buckets.delete(ip);
    }
  }
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

type CappedBody = { ok: true; body: string } | { ok: false; error: string };

/**
 * Read a small body with its own cap. Never rejects: an oversized or broken
 * request resolves as an error value, because every caller here must answer
 * the client rather than fall into a rejection nobody is awaiting.
 */
function readCappedBody(req: http.IncomingMessage, cap: number, tooLarge: string): Promise<CappedBody> {
  return new Promise((resolve) => {
    let size = 0;
    let over = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > cap) {
        over = true;
        resolve({ ok: false, error: tooLarge });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      // 'end' still fires after destroy(); the first resolve wins.
      if (!over) resolve({ ok: true, body: Buffer.concat(chunks).toString("utf8") });
    });
    req.on("error", () => {
      if (!over) resolve({ ok: false, error: "failed to read request body" });
    });
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
  includeUsage: boolean,
  servicedBy: string
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
        serviced_by: servicedBy,
        usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.prompt + usage.completion },
      })}\n\n`
    );
  }
  res.write("data: [DONE]\n\n");
}

/**
 * Live catalog for `/v1/models`: every provider's served models are fetched
 * through `listModels` — the same call `--ping-models` uses as its liveness
 * probe — and emitted as "<provider>:<model>" rows. A provider whose listing
 * fails (no key, unreachable, non-OpenAI shape) keeps its
 * "<provider>:<default>" row, so the response stays a strict superset of the
 * old default-only listing. A keyless provider can't be probed at all
 * (listModels refuses without credentials) — under --ping-models it is
 * honestly absent rather than optimistically listed.
 *
 * Cached 60s: a sweep is one network call per configured provider and
 * /v1/models gets hit on every playground load. Staleness is bounded by the
 * TTL, so a newly added key expands its provider's catalog within a minute.
 * `?refresh=1` bypasses the TTL for a caller that just changed a key and
 * wants the expanded catalog now (the playground's refresh button).
 */
type CatalogRow = {
  cfg: ReturnType<typeof listAllProviderConfigs>[number];
  /** true when listModels returned a live catalog this sweep. */
  live: boolean;
  /** expanded model ids; empty when the listing failed. */
  ids: string[];
};

let catalogCache: { at: number; rows: CatalogRow[] } | null = null;
const CATALOG_TTL_MS = 60_000;

/** Tests reset the module-level catalog cache so one test's sweep can't
 *  leak rows into the next. */
export function clearModelCatalogCache(): void {
  catalogCache = null;
}
/** Per-provider listing budget for the sweep — long enough to fetch a real
 *  catalog, short enough that 75 providers sweep in one bounded round. */
const SERVE_MODELS_TIMEOUT_MS = 2_000;

async function modelList(opts: ServeOptions, force = false): Promise<Record<string, unknown>> {
  const created = Math.floor(Date.now() / 1000);
  // /v1/models is the usable set — with the deny-by-default allowlist that
  // means exactly the enabled rows. Providers with no enabled model are not
  // even swept (skips ~134 catalog probes when the allowlist is empty).
  const configs = listAllProviderConfigs().filter((cfg) => providerIsEnabled(cfg.id));
  if (configs.length === 0) return { object: "list", data: [] };
  const fresh = catalogCache !== null && !force && Date.now() - catalogCache.at < CATALOG_TTL_MS;
  let rows: CatalogRow[];
  if (fresh && catalogCache !== null) {
    rows = catalogCache.rows;
  } else {
    rows = await Promise.all(
      configs.map(async (cfg) => {
        const { key } = resolveKey(cfg.id);
        const res = await listModels(cfg.id, key, SERVE_MODELS_TIMEOUT_MS);
        return res.ok && res.models.length > 0
          ? { cfg, live: true, ids: res.models.map((m) => m.id) }
          : { cfg, live: false, ids: [] as string[] };
      })
    );
    catalogCache = { at: Date.now(), rows };
  }
  const probed = new Map(rows.map((r) => [r.cfg.id, r]));
  // Enabled exact ids are listed unconditionally (an explicitly enabled model
  // is usable even if the 60s probe missed it); --ping-models narrows to ids
  // the live probe confirmed. Fresh file read per request, so CLI-side
  // enables show up here without waiting for the sweep cache.
  const data = configs.flatMap((cfg) =>
    allowedModelsFor(cfg.id)
      .filter((id) => {
        if (!opts.pingModels) return true;
        const r = probed.get(cfg.id);
        return r !== undefined && r.live && r.ids.includes(id);
      })
      .map((id) => ({
        id: `${cfg.id}:${id}`,
        object: "model" as const,
        created,
        owned_by: cfg.id,
      }))
  );
  return { object: "list", data };
}

/** Provider key manager UI as a route group on the serve server. */
const AUTH_UI = `/auth`;

/**
 * Sub-path of the auth UI that registers and removes custom providers — the
 * UI equivalent of `codewhip provider add/remove`.
 *
 * The leading underscore is deliberate: a provider id can only be `[a-z0-9-]`,
 * so `/_custom` can never be shadowed by a provider the user later names
 * "custom", "providers", or anything else — unlike a plain `/custom`, which
 * would silently become unreachable as a key endpoint the moment someone
 * registered that id.
 */
const CUSTOM_PATH = "/_custom";
const CUSTOM_UI = `${AUTH_UI}${CUSTOM_PATH}`;

/**
 * Sub-path for lazy per-provider model details — `GET /auth/_models/<id>`.
 * Same underscore-shield reasoning as `/_custom`: no provider id can shadow it.
 */
const MODELS_PATH = "/_models";

/**
 * Sub-path for the one-click starter consent write — `POST /auth/_starter`.
 * Same underscore-shield reasoning as the other control routes.
 */
const STARTER_PATH = "/_starter";

/** Listing budget for a single accordion expand — one provider, not the sweep.
 *  Generous enough for slow gateways (a 5 s probe made agnes list as if it had
 *  no catalog at all); the /v1/models sweep keeps its own tighter budget. */
const UI_MODELS_TIMEOUT_MS = 10_000;

const MAX_KEY_BYTES = 1024;
const MAX_CUSTOM_BODY_BYTES = 8 * 1024;

function sendHtml(res: http.ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html, "utf8") });
  res.end(html);
}

/** Escape for HTML text and attribute positions. */
function escapeHtml(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function authStatus(): Array<Record<string, unknown>> {
  const enabledCounts = new Map<string, number>();
  for (const entry of loadAllowedEntries()) {
    const k = parseEntry(entry);
    if (k !== null) enabledCounts.set(k.provider, (enabledCounts.get(k.provider) ?? 0) + 1);
  }
  return listAllProviderConfigsWithDisabled().map((cfg) => {
    const { key, source } = resolveKey(cfg.id);
    return {
      id: cfg.id,
      brand: cfg.brand,
      baseUrl: cfg.baseUrl,
      keyUrl: cfg.keyUrl,
      envVar: cfg.envVar,
      source,
      hasKey: key.length > 0,
      custom: !isBuiltinProviderId(cfg.id),
      disabled: cfg.disabled ?? false,
      enabledCount: enabledCounts.get(cfg.id) ?? 0,
    };
  });
}

/**
 * Shared UI foundation for the serve surfaces (playground + auth).
 * One token sheet, one type scale, one header — the two pages are one product.
 * Accent is near-black, not a brand color: the content is the color.
 * Built once and reused across every page render.
 */
let uiCssCache: string | null = null;
function uiCss(): string {
  if (uiCssCache === null) {
    uiCssCache = `:root{--bg:#f7f7f5;--surface:#fff;--fg:#1a1a1a;--muted:#6e6e6a;--line:#e3e3df;--accent:#1a1a1a;--accent-fg:#fff;--danger:#b30000;--ok:#0a7d32;--r:6px;--s1:4px;--s2:8px;--s3:12px;--s4:16px;--s5:24px}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--surface:#191b1e;--fg:#e8e8e6;--muted:#9a9a95;--line:#2a2d31;--accent:#e8e8e6;--accent-fg:#111214;--danger:#ff8080;--ok:#4cc38a}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
a{color:inherit}
h1{margin:0;font-size:16px;font-weight:600}
h2{margin:0;font-size:13px;font-weight:600}
.kicker{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
header{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:var(--s4);padding:var(--s3) var(--s5);background:var(--surface);border-bottom:1px solid var(--line)}
header .wordmark{font-weight:700}
header nav{display:flex;gap:var(--s3);font-size:13px}
header nav a{text-decoration:none;color:var(--muted)}
header nav a[aria-current=page]{color:var(--fg);font-weight:600}
header .note{margin-left:auto;font-size:12px;color:var(--muted)}
main{max-width:1100px;margin:0 auto;padding:var(--s5)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:var(--s4)}
button{font:inherit;cursor:pointer;padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r);background:var(--accent);color:var(--accent-fg);font-weight:600}
button.ghost{background:transparent;color:var(--fg)}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
button:disabled{opacity:.5;cursor:not-allowed}
input,select,textarea{font:inherit;width:100%;padding:var(--s2) var(--s3);border:1px solid var(--line);border-radius:var(--r);background:var(--bg);color:var(--fg)}
textarea{min-height:96px;resize:vertical}
label{display:block;font-weight:600;margin:var(--s2) 0 var(--s1)}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:var(--bg);border:1px solid var(--line);border-radius:4px;padding:1px var(--s1)}
.small{font-size:12px;color:var(--muted)}`;
  }
  return uiCssCache;
}

/** Shared header: wordmark, nav with current-page marker, honesty note. */
function uiHeader(title: string, active: "playground" | "stats" | "auth", note: string): string {
  const mark = (page: "playground" | "stats" | "auth", label: string): string =>
    `<a href="/${page}"${page === active ? ' aria-current="page"' : ""}>${label}</a>`;
  return `<header><span class="wordmark">codewhip</span><nav>${mark("playground", "playground")}${mark("stats", "stats")}${mark("auth", "keys & providers")}</nav><h1 style="position:absolute;left:-9999px">${title}</h1><span class="note">${note}</span></header>`;
}

function authHtml(): string {
  const status = authStatus();
  const totalEnabled = status.reduce((a, r) => a + (typeof r.enabledCount === "number" ? r.enabledCount : 0), 0);
  const rowHtml = (r: Record<string, unknown>): string => {
    const id = escapeHtml(r.id);
    const endpoint = r.custom === true ? `<div class="small">${escapeHtml(r.baseUrl)}</div>` : "";
    const keyUrl = String(r.keyUrl).length > 0 ? `<a href="${escapeHtml(r.keyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.keyUrl)}</a>` : `<span class="small">(none)</span>`;
    const keyState = r.hasKey ? `<span class="small" style="color:var(--ok)">key set (${escapeHtml(r.source)})</span>` : `<span class="small">no key</span>`;
    const search = escapeHtml(`${r.id} ${r.envVar} ${r.baseUrl ?? ""}`).toLowerCase();
    const n = typeof r.enabledCount === "number" ? r.enabledCount : 0;
    const badge = n > 0
      ? `<span class="badge ok" data-badge>${n} model${n === 1 ? "" : "s"} enabled</span>`
      : `<span class="badge" data-badge>none enabled</span>`;
    return `<li class="card prov" id="prov-${id}" data-search="${search}" data-id="${id}" style="list-style:none;margin-bottom:var(--s3)">
<div style="display:flex;justify-content:space-between;gap:var(--s3);flex-wrap:wrap;align-items:flex-start">
<div><strong>${id}</strong> ${badge}${r.custom === true ? ` <span class="small">custom</span>` : ""}${endpoint}</div>
<div style="display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap">
${keyState}
<button data-act="models" class="ghost">Manage models</button>
<button data-act="login">Set key</button>
${r.hasKey === true ? `<button data-act="logout" class="ghost">Remove key</button>` : ``}
${r.custom === true ? `<button data-act="remove" class="danger">Remove provider</button>` : ``}
</div>
</div>
<div class="keyrow" hidden>
<input type="password" class="keyinput" placeholder="paste ${escapeHtml(r.envVar)} value — stored 0600, never logged" autocomplete="new-password">
<button data-act="reveal" class="ghost">show</button>
<button data-act="save">Save key</button>
<span class="msg small"></span>
</div>
<div class="modelrow" hidden></div>
<div class="small" style="display:flex;gap:var(--s5);margin-top:var(--s2);flex-wrap:wrap">
<span>env <code>${escapeHtml(r.envVar)}</code></span>
<span>console ${keyUrl}</span>
</div>
</li>`;
  };
  const withKey = status.filter((r) => r.hasKey === true && r.custom !== true);
  const keyless = status.filter((r) => r.hasKey !== true && r.custom !== true);
  const custom = status.filter((r) => r.custom === true);
  const group = (label: string, rows: Array<Record<string, unknown>>): string =>
    rows.length === 0
      ? ""
      : `<section style="margin-bottom:var(--s5)"><h2 class="kicker" style="margin-bottom:var(--s3)">${label} (${rows.length})</h2><ul id="g-${label.replace(/\s/g, "")}" style="padding:0;margin:0">${rows.map(rowHtml).join("")}</ul></section>`;
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>codewhip auth</title><style>${uiCss()}
.keyrow{display:flex;gap:var(--s2);margin-top:var(--s3);align-items:center;flex-wrap:wrap}
[hidden]{display:none!important}
.keyrow input{flex:1;min-width:200px}
.msg.ok{color:var(--ok)}
.msg.bad{color:var(--danger)}
.badge{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}
.badge.ok{color:var(--ok)}
.modelrow{margin-top:var(--s3);border-top:1px solid var(--line);padding-top:var(--s3)}
.mlist{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:2px var(--s4);max-height:300px;overflow:auto;margin-top:var(--s2)}
.mrow{font-size:13px;display:flex;gap:var(--s2);align-items:baseline}
.mrow input{width:auto;margin:0}
.mtools{display:flex;gap:var(--s2);align-items:center;flex-wrap:wrap}
.msmall{color:var(--muted)}
.mfilter{margin:var(--s2) 0}
</style></head><body>
${uiHeader("codewhip auth — providers & keys", "auth", "this page spends your keys — it stores and removes them")}
<main>
<p class="small" style="margin-top:0"><strong>Everything is disabled until you enable it — model by model.</strong> ${status.length} providers · ${totalEnabled} model${totalEnabled === 1 ? "" : "s"} enabled · ${withKey.length} keys set · ${keyless.length} keyless · ${custom.length} custom. Open <em>Manage models</em> on a provider to tick models, or run <code>codewhip provider enable &lt;provider&gt;:&lt;model&gt;</code>.</p>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s5)">
<section>
<label for="provfilter" class="kicker">Filter providers</label>
<input id="provfilter" type="search" placeholder="Type an id, env var, or URL…" autocomplete="off" style="margin-bottom:var(--s4)">
${group("keys set", withKey)}
${group("keyless", keyless)}
${group("custom", custom)}
</section>
<section>
<div class="card">
<h2>Register custom endpoint</h2>
<form id="add" autocomplete="off" style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s3);margin-top:var(--s3)">
<div><label for="f-id">id</label><input id="f-id" name="id" required placeholder="my-gateway"></div>
<div><label for="f-baseUrl">base URL</label><input id="f-baseUrl" name="baseUrl" required placeholder="https://gateway.example.com"></div>
<div><label for="f-model">default model</label><input id="f-model" name="model" required placeholder="my-model"></div>
<div><label for="f-envVar">env var</label><input id="f-envVar" name="envVar" required placeholder="MY_GATEWAY_API_KEY"></div>
<div style="grid-column:1/-1"><label for="f-keyUrl">key URL</label><input id="f-keyUrl" name="keyUrl" placeholder="https://gateway.example.com/keys"></div>
<div style="grid-column:1/-1"><label for="f-key">API key <span style="font-weight:400;color:var(--muted)">optional – stored now instead of an env var</span></label><input id="f-key" name="key" type="password" autocomplete="new-password" placeholder="sk-..."></div>
<details style="grid-column:1/-1"><summary class="small">Advanced</summary>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--s3);margin-top:var(--s3)">
<div><label for="f-brand">brand</label><input id="f-brand" name="brand"></div>
<div><label for="f-chatPath">chat path</label><input id="f-chatPath" name="chatPath" placeholder="/v1/chat/completions"></div>
<div><label for="f-modelsPath">models path</label><input id="f-modelsPath" name="modelsPath" placeholder="/v1/models"></div>
<div><label for="f-timeoutMs">timeout ms</label><input id="f-timeoutMs" name="timeoutMs" inputmode="numeric"></div>
<div style="grid-column:1/-1"><label for="f-rateHint">rate hint</label><input id="f-rateHint" name="rateHint"></div>
</div>
</details>
<div class="err small" id="err" style="color:var(--danger)"></div>
<button type="submit" style="grid-column:1/-1">Register</button>
</form>
<p class="small">https:// anywhere, http:// on loopback for local runtimes like Ollama. Ids: lowercase letters, digits, dashes.</p>
</div>
</section>
</div>
</main>
<script>
document.getElementById('provfilter').addEventListener('input',e=>{
  const q=e.target.value.trim().toLowerCase();
  for(const li of document.querySelectorAll('li.prov')) li.style.display=!q||li.dataset.search.includes(q)?'':'none';
  for(const sec of document.querySelectorAll('section ul[id^="g-"]')) {
    const visible=[...sec.querySelectorAll('li.prov')].some(li=>li.style.display!=='none');
    sec.parentElement.style.display=visible?'':'none';
  }
});
const err=document.getElementById('err');
async function guarded(btn,label,fn){
  const orig=btn.textContent; btn.disabled=true; btn.textContent=label;
  try{return await fn();} finally{btn.disabled=false; btn.textContent=orig;}
}
async function failBody(res){
  const j=await res.json().catch(()=>null);
  return (j&&j.error&&j.error.message)||('failed ('+res.status+')');
}
document.getElementById('add').addEventListener('submit',async e=>{
  e.preventDefault();
  const form=e.target, btn=form.querySelector('button[type=submit]');
  const fd=new FormData(form);
  const key=String(fd.get('key')||'').trim();
  const body={}; fd.forEach((v,k)=>{if(k==='key') return; const s=String(v).trim(); if(s) body[k]=s;});
  err.textContent='';
  await guarded(btn,'Registering…',async()=>{
    try{
      const res=await fetch('/auth/_custom',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      if(!res.ok){err.textContent=await failBody(res); return false;}
      if(key){
        const kres=await fetch('/auth/'+encodeURIComponent(body.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
        if(!kres.ok){err.textContent='endpoint registered, but the key failed to save: '+await failBody(kres); return false;}
      }
      location.reload(); return true;
    }catch(e2){err.textContent='network error'; return false;}
  });
});
document.addEventListener('click',async e=>{
  const mb=e.target.closest('button[data-mact]');
  if(mb){
    const mcard=mb.closest('li.prov'); if(!mcard) return;
    const mid=mcard.dataset.id;
    if(mb.dataset.mact==='all'){
      for(const i of mcard.querySelectorAll('.mlist input[type=checkbox]')) i.checked=true;
      saveModels(mcard);
    }
    if(mb.dataset.mact==='none'){
      await guarded(mb,'Disabling…',async()=>{
        try{
          const res=await fetch('/auth/'+encodeURIComponent(mid)+'/allowlist',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({all:false})});
          if(!res.ok){ showSaved(mcard,await failBody(res),true); return false; }
          const data=await res.json();
          for(const i of mcard.querySelectorAll('.mlist input[type=checkbox]')) i.checked=false;
          setBadge(mcard,(data.allowed||[]).length);
          showSaved(mcard,'saved',false);
          return true;
        }catch(e2){showSaved(mcard,'network error',true); return false;}
      });
    }
    return;
  }
  const b=e.target.closest('button[data-act]'); if(!b) return;
  const card=b.closest('li.prov'); if(!card) return;
  const id=card.dataset.id;
  const msg=card.querySelector('.msg');
  const say=(t,bad)=>{msg.textContent=t; msg.classList.toggle('bad',!!bad); msg.classList.toggle('ok',!bad);};
  const act=b.dataset.act;
  if(act==='login'){
    const row=card.querySelector('.keyrow');
    row.hidden=!row.hidden;
    if(!row.hidden){
      const inp=card.querySelector('.keyinput');
      inp.focus();
      inp.onkeydown=(ev)=>{if(ev.key==='Escape'){row.hidden=true; b.focus();}};
    }
    return;
  }
  if(act==='reveal'){
    const inp=card.querySelector('.keyinput');
    inp.type=inp.type==='password'?'text':'password';
    b.textContent=inp.type==='password'?'show':'hide';
    return;
  }
  if(act==='save'){
    const inp=card.querySelector('.keyinput');
    const key=inp.value.trim();
    if(!key){say('paste a key first',true); return;}
    say('saving…',false);
    await guarded(b,'Saving…',async()=>{
      try{
        const res=await fetch('/auth/'+encodeURIComponent(id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});
        if(!res.ok){say(await failBody(res),true); inp.focus(); return false;}
        say('key saved — reloading',false);
        setTimeout(()=>location.reload(),400);
        return true;
      }catch(e2){say('network error',true); return false;}
    });
    return;
  }
  if(act==='logout'){
    if(!confirm('Remove stored '+id+' key?')) return;
    await guarded(b,'Removing…',async()=>{
      try{
        const res=await fetch('/auth/'+encodeURIComponent(id),{method:'DELETE'});
        if(!res.ok){say(await failBody(res),true); return false;}
        location.reload(); return true;
      }catch(e2){say('network error',true); return false;}
    });
    return;
  }
  if(act==='remove'){
    if(!confirm('Remove custom provider '+id+'?')) return;
    await guarded(b,'Removing…',async()=>{
      try{
        const res=await fetch('/auth/_custom/'+encodeURIComponent(id),{method:'DELETE'});
        if(!res.ok){say(await failBody(res),true); return false;}
        location.reload(); return true;
      }catch(e2){say('network error',true); return false;}
    });
    return;
  }
  if(act==='models'){
    const panel=card.querySelector('.modelrow');
    panel.hidden=!panel.hidden;
    if(!panel.hidden && !panel.dataset.loaded) loadModels(card);
    return;
  }
});
function setBadge(card,n){
  const el=card.querySelector('[data-badge]'); if(!el) return;
  el.textContent=n>0?(n+' model'+(n===1?'':'s')+' enabled'):'none enabled';
  el.classList.toggle('ok',n>0);
}
function showSaved(card,text,bad){
  const el=card.querySelector('.msmall'); if(!el) return;
  el.textContent=text;
  el.style.color=bad?'var(--danger)':'';
  if(!bad) setTimeout(()=>{el.textContent='';},1500);
}
async function saveModels(card){
  clearTimeout(card._t);
  const checked=[...card.querySelectorAll('.mlist input[type=checkbox]')].map(i=>i.value);
  showSaved(card,'saving…',false);
  try{
    const res=await fetch('/auth/'+encodeURIComponent(card.dataset.id)+'/allowlist',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({models:checked})});
    if(!res.ok){showSaved(card,await failBody(res),true); return;}
    const data=await res.json();
    setBadge(card,(data.allowed||[]).length);
    showSaved(card,'saved',false);
  }catch(e){showSaved(card,'network error',true);}
}
async function loadModels(card){
  const panel=card.querySelector('.modelrow');
  panel.dataset.loaded='1';
  panel.innerHTML='<span class="small">loading models…</span>';
  try{
    const res=await fetch('/auth/_models/'+encodeURIComponent(card.dataset.id));
    if(!res.ok){panel.innerHTML='<span class="small">failed to load models</span>'; panel.dataset.loaded=''; return;}
    renderModels(card,await res.json());
  }catch(e){panel.innerHTML='<span class="small">network error</span>'; panel.dataset.loaded='';}
}
function renderModels(card,data){
  const panel=card.querySelector('.modelrow');
  const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  let html='';
  if(data.listingError) html+='<div class="small">'+esc(data.listingError)+'</div>';
  html+='<div class="mtools"><button data-mact="all">Enable all listed</button><button data-mact="none" class="ghost">Disable all</button><span class="msmall small"></span></div>';
  if(data.models.length>50) html+='<input class="mfilter" type="search" placeholder="Filter models…" autocomplete="off">';
  html+='<div class="mlist">'+data.models.map(m=>'<label class="mrow"><input type="checkbox" value="'+esc(m.id)+'"'+(m.enabled?' checked':'')+'><code>'+esc(m.id)+'</code>'+(m.isDefault?' <span class="small">(default)</span>':'')+(m.live?'':' <span class="small">not in live catalog</span>')+'</label>').join('')+'</div>';
  panel.innerHTML=html;
}
document.addEventListener('change',e=>{
  const el=e.target;
  if(el.matches && el.matches('.mlist input[type=checkbox]')){
    const card=el.closest('li.prov');
    clearTimeout(card._t);
    card._t=setTimeout(()=>saveModels(card),300);
  }
});
document.addEventListener('input',e=>{
  const el=e.target;
  if(!el.classList || !el.classList.contains('mfilter')) return;
  const panel=el.closest('.modelrow');
  const q=el.value.trim().toLowerCase();
  for(const lb of panel.querySelectorAll('.mrow')) lb.style.display=!q||lb.textContent.toLowerCase().includes(q)?'':'none';
});
</script></body></html>`;
}

let playgroundCache: string | null = null;
function playgroundHtml(): string {
  if (playgroundCache === null) {
    playgroundCache = `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>codewhip playground</title><style>
${uiCss()}
main{display:grid;grid-template-columns:360px 1fr;gap:var(--s5);align-items:start}
@media (max-width:900px){main{grid-template-columns:1fr}}
#chat{min-height:420px;max-height:70vh;overflow:auto;display:flex;flex-direction:column;gap:var(--s4)}
.turn .body{white-space:pre-wrap;font-size:14px}
.turn.assistant .body{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
.turn.user .body{background:var(--bg);border:1px solid var(--line);border-radius:var(--r);padding:var(--s2) var(--s3)}
.receipt{font-size:11px;color:var(--muted);margin-top:var(--s1)}
</style></head><body>
${uiHeader("codewhip playground", "playground", "requests run through the local proxy — auto picks a healthy free model")}
<main>
<section class="card">
<label for="modelfilter">Model <span class="small" id="modelBadge">loading…</span> <button id="refresh" class="ghost" style="padding:2px 8px;margin-left:var(--s2)">refresh</button> <button id="retry" class="ghost" hidden style="padding:2px 8px;margin-left:var(--s2)">retry</button></label>
<input id="modelfilter" type="search" placeholder="Filter — type a provider or model" autocomplete="off">
<select id="model" style="margin-top:var(--s2)"><option value="auto" selected>auto — health-weighted pick</option></select>
<label for="system" style="margin-top:var(--s4)">System <span class="small">optional, sent with every request</span></label>
<textarea id="system" rows="2" placeholder="Optional system prompt"></textarea>
<label for="prompt">Prompt</label>
<textarea id="prompt" placeholder="Type a prompt…"></textarea>
<div style="display:flex;gap:var(--s2);align-items:center;margin-top:var(--s3);flex-wrap:wrap">
<label class="small" for="stream" style="display:flex;gap:var(--s1);margin:0;font-weight:400;align-items:center"><input type="checkbox" id="stream" style="width:auto" checked> Stream</label>
<span style="flex:1"></span>
<button id="send">Send</button>
<button id="stop" class="ghost">Stop</button>
<button id="clear" class="ghost">Clear thread</button>
</div>
<div id="err" class="small" style="color:var(--danger);margin-top:var(--s2)" role="alert"></div>
</section>
<section class="card">
<h2 class="kicker">Thread</h2>
<div id="chat" aria-live="polite"></div>
</section>
</main>
<script>
const $ = s=>document.querySelector(s);
const modelSel=$('#model'), filterEl=$('#modelfilter'), sys=$('#system'), promptEl=$('#prompt'), streamEl=$('#stream');
const chat=$('#chat'), err=$('#err'), badge=$('#modelBadge');
let controller=null, messages=[], allModels=[];
function turn(role, text){
  const wrap=document.createElement('div'); wrap.className='turn '+role;
  const kick=document.createElement('div'); kick.className='kicker'; kick.textContent=role;
  const body=document.createElement('div'); body.className='body'; body.textContent=text;
  wrap.append(kick, body); chat.append(wrap); chat.scrollTop=chat.scrollHeight;
  return body;
}
function receipt(body, parts){
  const r=document.createElement('div'); r.className='receipt'; r.textContent=parts.filter(Boolean).join(' · ');
  body.parentElement.append(r); chat.scrollTop=chat.scrollHeight;
}
function renderModels(){
  const q=filterEl.value.trim().toLowerCase();
  modelSel.innerHTML='';
  const groups=new Map();
  let n=0;
  for(const id of allModels){
    if(q && !id.toLowerCase().includes(q)) continue;
    n++;
    const colon=id.indexOf(':');
    const prov=colon>0?id.slice(0,colon):'other';
    if(!groups.has(prov)) groups.set(prov,[]);
    groups.get(prov).push(id);
  }
  const auto=document.createElement('option');
  auto.value='auto'; auto.textContent='auto — health-weighted pick';
  if(!q || 'auto'.includes(q)) modelSel.append(auto);
  for(const prov of [...groups.keys()].sort()){
    const og=document.createElement('optgroup'); og.label=prov;
    for(const id of groups.get(prov).sort()){
      const o=document.createElement('option'); o.value=id; o.textContent=id; og.append(o);
    }
    modelSel.append(og);
  }
  const saved=localStorage.getItem('codewhip.model');
  if(saved){modelSel.value=saved; if(modelSel.value!==saved) localStorage.removeItem('codewhip.model');}
  if(!saved||modelSel.value!==saved) modelSel.value='auto';
  badge.textContent=allModels.length+' models'+(q?' · '+n+' match':'');
}
async function loadModels(force){
  const retry=$('#retry'); retry.hidden=true;
  try{
    // force=true appends ?refresh=1 so the server re-sweeps every provider's
    // catalog instead of serving the 60s cache — the refresh button's path.
    const res=await fetch('/v1/models'+(force?'?refresh=1':''));
    if(!res.ok) throw new Error(String(res.status));
    const j=await res.json();
    allModels=(j.data||[]).map(m=>m.id).sort();
    renderModels();
  }catch(e){
    badge.textContent='could not load models — is the proxy running?';
    retry.hidden=false;
  }
}
$('#retry').addEventListener('click',()=>loadModels(false));
$('#refresh').addEventListener('click',async()=>{badge.textContent='refreshing…'; await loadModels(true);});
loadModels(false);
filterEl.addEventListener('input',renderModels);
modelSel.addEventListener('change',()=>{try{localStorage.setItem('codewhip.model',modelSel.value);}catch{}});
$('#clear').addEventListener('click',()=>{chat.textContent=''; err.textContent=''; messages=[];});
$('#stop').addEventListener('click',()=>{if(controller){controller.abort(); controller=null; err.textContent='Stopped';}});
async function send(){
  err.textContent='';
  const model=modelSel.value, system=sys.value.trim(), prompt=promptEl.value.trim();
  if(!model){err.textContent='Select a model'; modelSel.focus(); return;}
  if(!prompt){err.textContent='Enter a prompt'; promptEl.focus(); return;}
  turn('user',prompt); promptEl.value='';
  const outgoing=system?[{role:'system',content:system},...messages,{role:'user',content:prompt}]:[...messages,{role:'user',content:prompt}];
  const body=turn('assistant','');
  const t0=performance.now();
  controller=new AbortController();
  let usage=null, servicedBy=null, toolCalls=[];
  try{
    const res=await fetch('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages:outgoing,stream:streamEl.checked,...(streamEl.checked?{stream_options:{include_usage:true}}:{})}),signal:controller.signal});
    if(!res.ok){
      const j=await res.json().catch(()=>null);
      err.textContent='Error '+res.status+(j&&j.error&&j.error.message?': '+j.error.message:'');
      body.parentElement.remove(); messages.push({role:'user',content:prompt}); return;
    }
    let text='';
    if(streamEl.checked){
      const reader=res.body.getReader(), dec=new TextDecoder(); let buf='';
      while(true){
        const {value,done}=await reader.read(); if(done) break;
        buf+=dec.decode(value,{stream:true});
        const lines=buf.split('\\n'); buf=lines.pop();
        for(const line of lines){
          if(!line.startsWith('data:')) continue;
          const data=line.slice(5).trim();
          if(data==='[DONE]') continue;
          try{
            const j=JSON.parse(data);
            const c=j.choices?.[0]?.delta?.content;
            if(c){text+=c; body.textContent=text; chat.scrollTop=chat.scrollHeight;}
            const tc=j.choices?.[0]?.delta?.tool_calls;
            if(tc) toolCalls.push(...tc);
            if(j.usage) usage=j.usage;
            if(j.serviced_by) servicedBy=j.serviced_by;
          }catch{}
        }
      }
    }else{
      const j=await res.json();
      text=j.choices?.[0]?.message?.content ?? '';
      const tcs=j.choices?.[0]?.message?.tool_calls;
      if(tcs) toolCalls=tcs;
      if(j.usage) usage=j.usage;
      if(j.serviced_by) servicedBy=j.serviced_by;
    }
    body.textContent=text;
    if(toolCalls.length>0){
      const tn=document.createElement('div'); tn.className='receipt';
      tn.textContent='⚙ '+toolCalls.map(c=>c.function&&c.function.name?c.function.name+'()':'tool call').join(', ');
      body.parentElement.append(tn);
    }
    const secs=((performance.now()-t0)/1000).toFixed(1)+'s';
    const toks=usage?(usage.prompt_tokens+usage.completion_tokens)+' tok'+(usage.estimated?' (est.)':''):null;
    const tools=toolCalls.length>0?toolCalls.length+' tool call'+(toolCalls.length>1?'s':''):null;
    receipt(body,[model==='auto'&&servicedBy?servicedBy:null,secs,toks,tools].filter(x=>x!==null));
    messages.push({role:'user',content:prompt},{role:'assistant',content:text});
  }catch(e){
    if(e.name!=='AbortError'){err.textContent='Network error'; body.parentElement.remove(); messages.push({role:'user',content:prompt});}
    else{receipt(body,['stopped',((performance.now()-t0)/1000).toFixed(1)+'s']); messages.push({role:'user',content:prompt});}
  }
  finally{controller=null;}
}
$('#send').addEventListener('click',send);
promptEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();send();}});
document.addEventListener('keydown',e=>{
  const tag=document.activeElement?document.activeElement.tagName:'';
  if(e.key==='/'&&tag!=='INPUT'&&tag!=='TEXTAREA'&&tag!=='SELECT'){e.preventDefault();filterEl.focus();}
  if(e.key==='Escape'&&controller){controller.abort();controller=null;err.textContent='Stopped';}
});
</script>
</body></html>`;
  }
  return playgroundCache;
}

/**
 * GET /stats — aggregated provider health, rendered server-side.
 *
 * Aggregates only: the per-request history endpoint was removed on purpose
 * (d8f784f) and this page does not bring it back. Every number here is what
 * auto-routing itself reads; tokens appear only when upstream reported them.
 */
function statsHtml(): string {
  const s = summarizeCalls(readProviderCalls());
  const now = Date.now();
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const sections =
    s.total === 0
      ? `<div class="card"><p>No calls recorded yet.</p><p class="small">Traffic shows up here after the first chat completion or model listing — open the <a href="/playground">playground</a> and send one.</p></div>`
      : s.providers
          .map((ph) => {
            const rows = ph.models
              .map((mh) => {
                if (mh.model === LISTING_MODEL) {
                  return `<tr class="dim"><td colspan="7">· model-listing checks: ${pct(mh.successRate)} (${mh.ok}/${mh.total})</td></tr>`;
                }
                let status = "";
                const failOutcome = mh.lastFailureOutcome;
                if (mh.lastFailureTs !== undefined && failOutcome !== undefined && failOutcome !== "ok") {
                  const ttl = TTL_MS[failOutcome] ?? 5 * 60_000;
                  const remain = ttl - (now - new Date(mh.lastFailureTs).getTime());
                  if (remain > 0) {
                    status = `<span class="warn">cooling ${Math.ceil(remain / 60_000)}m · ${failOutcome}</span>`;
                  }
                }
                const toks = mh.promptTokens + mh.completionTokens;
                return `<tr>
<td><code>${escapeHtml(mh.model)}</code></td>
<td>${pct(mh.successRate)}</td>
<td>${mh.ok}/${mh.total}</td>
<td>${mh.avgMs > 0 ? `${Math.round(mh.avgMs)}ms` : "—"}</td>
<td>${toks > 0 ? `${fmtTok(toks)} tok` : "—"}</td>
<td>${mh.tokensPerSec > 0 ? `${mh.tokensPerSec.toFixed(0)} tok/s` : "—"}</td>
<td>${status}</td>
</tr>`;
              })
              .join("");
            const toks = ph.promptTokens + ph.completionTokens;
            return `<section class="card" style="margin-bottom:var(--s4);padding:0;overflow:hidden">
<div style="display:flex;gap:var(--s5);padding:var(--s3) var(--s4);border-bottom:1px solid var(--line);flex-wrap:wrap;align-items:baseline">
<strong>${escapeHtml(ph.provider)}</strong>
<span class="small">${pct(ph.successRate)} ok (${ph.ok}/${ph.total})</span>
<span class="small">${ph.avgMs > 0 ? `${Math.round(ph.avgMs)}ms avg` : ""}</span>
<span class="small">${toks > 0 ? `${fmtTok(toks)} tok @ ${ph.tokensPerSec.toFixed(0)} tok/s` : ""}</span>
<a href="/auth#prov-${escapeHtml(ph.provider)}" class="small" style="margin-left:auto">manage key →</a>
</div>
<table>
<thead><tr><th>model</th><th>success</th><th>ok/total</th><th>avg ms</th><th>tokens</th><th>speed</th><th></th></tr></thead>
<tbody>${rows}</tbody>
</table>
</section>`;
          })
          .join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>codewhip stats</title><style>
${uiCss()}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:var(--s2) var(--s4);text-align:left;border-bottom:1px solid var(--line)}
th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);font-weight:600}
tbody tr:last-child td{border-bottom:none}
.dim td{color:var(--muted)}
.warn{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:var(--r);padding:1px var(--s2)}
</style></head><body>
${uiHeader("codewhip stats — provider health", "stats", "aggregates only — per-request history is never served")}
<main>
<p class="small" style="margin-top:0">${s.total} calls recorded across ${s.providers.length} providers. Tokens appear only when the upstream provider reported usage — estimates are never invented here. A model marked <em>cooling</em> is temporarily skipped by <code>auto</code>.</p>
${sections}
</main>
</body></html>`;
}

/** Body of `POST /auth/_custom`, before validation. */
type CustomProviderBody = {
  id?: unknown;
  baseUrl?: unknown;
  model?: unknown;
  envVar?: unknown;
  brand?: unknown;
  chatPath?: unknown;
  modelsPath?: unknown;
  keyUrl?: unknown;
  timeoutMs?: unknown;
  rateHint?: unknown;
};

/** non-string → "". normalize() trims strings, so a number would throw there. */
function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Absent → undefined (the default wins); garbage → NaN, which normalize rejects. */
function asTimeout(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim().length > 0) return Number(value);
  return undefined;
}

/**
 * Register and remove custom providers from the UI — `codewhip provider
 * add/remove` for people who never open a terminal.
 *
 * Validation is deliberately NOT duplicated here: every rejection is
 * `addCustomProvider`'s own message, so the form and the CLI can never
 * disagree about what a valid endpoint is (https anywhere, or http on
 * loopback; no builtin id collisions; UPPER_SNAKE env var; …).
 */
async function handleCustomRoutes(req: http.IncomingMessage, res: http.ServerResponse, rest: string): Promise<void> {
  const id = rest.replace(/^\//, "").replace(/\/$/, "");
  if (req.method === "GET" && id.length === 0) {
    sendJson(res, 200, { data: authStatus().filter((r) => r.custom === true) });
    return;
  }
  if (req.method === "POST" && id.length === 0) {
    const body = await readCappedBody(req, MAX_CUSTOM_BODY_BYTES, "request body too large");
    if (!body.ok) {
      sendJson(res, 413, { error: { message: body.error, code: "too_large" } });
      return;
    }
    let parsed: CustomProviderBody;
    try {
      parsed = JSON.parse(body.body) as CustomProviderBody;
    } catch {
      sendJson(res, 400, { error: { message: "invalid JSON", code: "invalid_json" } });
      return;
    }
    const timeoutMs = asTimeout(parsed.timeoutMs);
    const result = addCustomProvider({
      id: asText(parsed.id),
      baseUrl: asText(parsed.baseUrl),
      defaultModel: asText(parsed.model),
      envVar: asText(parsed.envVar),
      brand: asText(parsed.brand),
      chatPath: asText(parsed.chatPath),
      modelsPath: asText(parsed.modelsPath),
      keyUrl: asText(parsed.keyUrl),
      rateLimitedHint: asText(parsed.rateHint),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    if (!result.ok) {
      sendJson(res, 400, { error: { message: result.error, code: "invalid_provider" } });
      return;
    }
    const cfg = getProviderConfig(result.id);
    // `local` is the signal the UI turns into "no credential needed".
    // A new provider joins /v1/models on the next sweep — clear the cache so
    // the playground shows it immediately rather than waiting for the TTL.
    clearModelCatalogCache();
    sendJson(res, 201, {
      id: result.id,
      baseUrl: cfg?.baseUrl ?? "",
      defaultModel: cfg?.defaultModel ?? "",
      envVar: cfg?.envVar ?? "",
      local: cfg !== null && isLoopbackBaseUrl(cfg.baseUrl),
    });
    return;
  }
  if (req.method === "DELETE" && id.length > 0) {
    if (isBuiltinProviderId(id.trim().toLowerCase())) {
      sendJson(res, 400, { error: { message: `"${id}" is a builtin provider and cannot be removed`, code: "builtin_provider" } });
      return;
    }
    const result = removeCustomProvider(id);
    // A removed provider leaves /v1/models on the next sweep.
    clearModelCatalogCache();
    if (!result.ok) {
      sendJson(res, 404, { error: { message: result.error, code: "unknown_provider" } });
      return;
    }
    sendJson(res, 200, { id, removed: true });
    return;
  }
  sendError(
    res,
    405,
    `method ${req.method ?? ""} not allowed on ${CUSTOM_UI} (POST to register, DELETE ${CUSTOM_UI}/<id> to remove)`,
    "method_not_allowed"
  );
}

/**
 * `GET /auth/_models/<id>` — the per-provider accordion detail:
 * live catalog ∪ enabled exact ids ∪ the default model, one row each.
 * Lazy on purpose: a page load costs O(providers); only the provider you
 * open pays for its (possibly 380-row) catalog. Never sweeps the registry.
 */
async function handleProviderModels(res: http.ServerResponse, id: string): Promise<void> {
  const cfg = getProviderConfig(id);
  if (cfg === null) {
    sendJson(res, 404, { error: { message: `unknown provider "${id}"`, code: "unknown_provider" } });
    return;
  }
  const enabled = new Set(allowedModelsFor(cfg.id));
  const { key } = resolveKey(cfg.id);
  const listed = key.length > 0
    ? await listModels(cfg.id, key, UI_MODELS_TIMEOUT_MS)
    : { ok: false as const, error: "no key set, so the live model list can't be fetched — you can still enable models by exact id" };
  const live = listed.ok ? new Set(listed.models.map((m) => m.id)) : new Set<string>();
  const tagById = new Map(listed.ok ? listed.models.map((m) => [m.id, m.tag] as const) : []);
  // ★ = trackable $0, confirmed live right now, and not an embeddings/OCR-only
  // endpoint. Untracked prices are deliberately NOT recommended: "unknown" is
  // not "free", and one-click consent must only ever point at proven $0 rows.
  const recommended = (mid: string): boolean =>
    live.has(mid) &&
    tagById.get(mid) !== "non-chat" &&
    estimateCost(cfg.id as ProviderId, mid, 1000, 1000) === 0;
  const ids = new Set<string>([cfg.defaultModel, ...enabled, ...live]);
  const models = [...ids]
    .sort((a, b) => (a === cfg.defaultModel ? -1 : b === cfg.defaultModel ? 1 : a.localeCompare(b)))
    .map((mid) => ({
      id: mid,
      isDefault: mid === cfg.defaultModel,
      live: live.has(mid),
      enabled: enabled.has(mid),
      recommended: recommended(mid),
    }));
  sendJson(res, 200, { id: cfg.id, models, ...(listed.ok ? {} : { listingError: listed.error }) });
}

/** How many models the starter set may enable in one click (consent cap). */
const STARTER_CAP = 6;

/**
 * `POST /auth/_starter` — the smallest honest "make the playground usable"
 * click: ADDITIVELY enables the anonymous free-chain providers whose DEFAULT
 * model is a tracked $0 (never untracked — unknown is not free). Cap keeps one
 * click from becoming a bulk consent; already-enabled entries stay untouched.
 */
function handleStarter(res: http.ServerResponse): void {
  const entries: string[] = [];
  for (const fe of FREE_CHAIN) {
    if (entries.length >= STARTER_CAP) break;
    if (fe.keyNeeded !== "no") continue;
    const cfg = getProviderConfig(fe.id);
    if (cfg === null || cfg.disabled === true) continue;
    // "auto" is a routing word, not a model id — a provider defaulting to it
    // contributes nothing to a starter set.
    if (cfg.defaultModel === "auto") continue;
    if (estimateCost(cfg.id as ProviderId, cfg.defaultModel, 1000, 1000) !== 0) continue;
    entries.push(`${cfg.id}:${cfg.defaultModel}`);
  }
  const r = enableEntries(entries);
  if (!r.ok) {
    sendJson(res, 400, { error: { message: r.error, code: "invalid_allowlist" } });
    return;
  }
  clearModelCatalogCache();
  sendJson(res, 200, { ok: true, added: r.added, considered: entries });
}

/**
 * `PUT /auth/<id>/allowlist` — the consent write.
 * `{"models":[…]}` replaces this provider's enabled set (exact ids);
 * `{"all":true}` enables the ids the live catalog lists RIGHT NOW (never a
 * wildcard — a catalog change can't silently re-open access);
 * `{"all":false}` disables the provider.
 */
async function handleAllowlistPut(req: http.IncomingMessage, res: http.ServerResponse, id: string): Promise<void> {
  const cfg = getProviderConfig(id);
  if (cfg === null) {
    sendJson(res, 404, { error: { message: `unknown provider "${id}"`, code: "unknown_provider" } });
    return;
  }
  const body = await readCappedBody(req, MAX_CUSTOM_BODY_BYTES, "request body too large");
  if (!body.ok) {
    sendJson(res, 413, { error: { message: body.error, code: "too_large" } });
    return;
  }
  let p: { models?: unknown; all?: unknown };
  try {
    p = JSON.parse(body.body) as { models?: unknown; all?: unknown };
  } catch {
    sendJson(res, 400, { error: { message: "invalid JSON", code: "invalid_json" } });
    return;
  }
  const respond = (r: { ok: true; allowed: string[] } | { ok: false; error: string }): void => {
    if (!r.ok) {
      sendJson(res, 400, { error: { message: r.error, code: "invalid_allowlist" } });
      return;
    }
    // Consent changed — the playground's /v1/models dropdown must not wait
    // out the sweep cache.
    clearModelCatalogCache();
    sendJson(res, 200, { id: cfg.id, allowed: r.allowed });
  };
  if (typeof p.all === "boolean") {
    if (!p.all) {
      respond(setProviderAllowlist(cfg.id, []));
      return;
    }
    const { key } = resolveKey(cfg.id);
    const listed = key.length > 0 ? await listModels(cfg.id, key, UI_MODELS_TIMEOUT_MS) : { ok: false as const, error: "no key" };
    if (!listed.ok) {
      sendJson(res, 400, { error: { message: `cannot list ${cfg.id} models (${listed.error}) — enable models individually`, code: "listing_unavailable" } });
      return;
    }
    respond(setProviderAllowlist(cfg.id, listed.models.map((m) => m.id)));
    return;
  }
  if (!Array.isArray(p.models) || !p.models.every((m) => typeof m === "string")) {
    sendJson(res, 400, { error: { message: 'body {"models":["id",…]} or {"all":true|false} required', code: "invalid_allowlist" } });
    return;
  }
  respond(setProviderAllowlist(cfg.id, p.models as string[]));
}

async function handleAuthUi(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith(AUTH_UI)) return false;
  const rest = path.slice(AUTH_UI.length); // "" | "/<id>" | "/_custom" | "/_custom/<id>" | "/_models/<id>" | "/<id>/allowlist"
  if (rest === CUSTOM_PATH || rest.startsWith(`${CUSTOM_PATH}/`)) {
    await handleCustomRoutes(req, res, rest.slice(CUSTOM_PATH.length));
    return true;
  }
  if (req.method === "GET" && (rest === MODELS_PATH || rest.startsWith(`${MODELS_PATH}/`))) {
    await handleProviderModels(res, rest.slice(MODELS_PATH.length).replace(/^\//, "").replace(/\/$/, ""));
    return true;
  }
  if (rest === STARTER_PATH) {
    if (req.method !== "POST") {
      sendError(res, 405, `method ${req.method ?? ""} not allowed on ${AUTH_UI}${STARTER_PATH} (POST only)`, "method_not_allowed");
      return true;
    }
    handleStarter(res);
    return true;
  }
  const allowMatch = /^\/([^/]+)\/allowlist\/?$/.exec(rest);
  if (allowMatch !== null) {
    if (req.method !== "PUT") {
      sendError(res, 405, `method ${req.method ?? ""} not allowed on allowlist (PUT only)`, "method_not_allowed");
      return true;
    }
    await handleAllowlistPut(req, res, allowMatch[1] as string);
    return true;
  }
  // GET /auth → HTML page
  if (req.method === "GET" && (rest === "" || rest === "/")) {
    sendHtml(res, authHtml());
    return true;
  }
  // GET /auth/:id → JSON status
  const id = rest.replace(/^\//, "").replace(/\/$/, "");
  if (id.length === 0) {
    sendJson(res, 200, { data: authStatus() });
    return true;
  }
  const builtin = PROVIDERS[id as keyof typeof PROVIDERS];
  const custom = builtin === undefined ? getProviderConfig(id) : builtin;
  if (builtin === undefined && custom === null) {
    sendJson(res, 404, { error: { message: `unknown provider "${id}"`, code: "not_found" } });
    return true;
  }
  if (req.method === "GET") {
    const { key } = resolveKey(id);
    sendJson(res, 200, { id, hasKey: key.length > 0 });
    return true;
  }
  if (req.method === "POST") {
    const body = await readCappedBody(req, MAX_KEY_BYTES, "key too large");
    if (!body.ok) {
      sendJson(res, 413, { error: { message: body.error, code: "too_large" } });
      return true;
    }
    let p: { key?: unknown };
    try {
      p = JSON.parse(body.body) as { key?: unknown };
    } catch {
      sendJson(res, 400, { error: { message: "invalid JSON", code: "invalid_json" } });
      return true;
    }
    if (typeof p.key !== "string" || p.key.length === 0) {
      sendJson(res, 400, { error: { message: "body {\"key\":\"<value>\"} required", code: "invalid_key" } });
      return true;
    }
    const lockWarning = saveKey(id, p.key);
    if (lockWarning !== null) console.warn(`[codewhip serve] warning: ${lockWarning}`);
    // A newly-stored key unlocks a provider's full catalog — drop the cached
    // /v1/models sweep so the next load re-probes and expands the rows.
    clearModelCatalogCache();
    sendJson(res, 200, { id, source: "file" });
    return true;
  }
  if (req.method === "DELETE") {
    clearKey(id);
    // A removed key shrinks the catalog back to the default-model row.
    clearModelCatalogCache();
    sendJson(res, 200, { id, source: resolveKey(id).source });
    return true;
  }
  sendError(res, 405, `method ${req.method ?? ""} not allowed on /auth`, "method_not_allowed");
  return true;
}

export function createServeHandler(opts: ServeOptions): http.RequestListener {
  // One limiter per server instance so tests get fresh buckets.
  const limiter = new IpRateLimiter();
  return (req, res): void => {
    void handle(req, res, opts, limiter);
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, opts: ServeOptions, limiter: IpRateLimiter): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];
  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    sendJson(res, 200, { status: "ok" });
    return;
  }
  // Only /health is public (load-balancer checks must work without the
  // bearer). Everything else — playground, the auth UI/API, /v1/* — sits
  // behind the token when one is configured: the auth UI spends your keys.
  // There is deliberately no /stats here: per-request history stays out of
  // the proxy entirely (see `codewhip stats` for the local CLI view).
  if (opts.token) {
    if (!bearerMatches(req.headers.authorization, opts.token)) {
      sendError(res, 401, "missing or invalid bearer token for this server", "invalid_api_key");
      return;
    }
  }
  if (req.method === "GET" && path === "/playground") {
    sendHtml(res, playgroundHtml());
    return;
  }
  if (req.method === "GET" && path === "/stats") {
    sendHtml(res, statsHtml());
    return;
  }
  if (opts.authUi && path.startsWith(AUTH_UI)) {
    await handleAuthUi(req, res, path);
    return;
  }
  if (req.method === "GET" && path === "/v1/models") {
    // ?refresh=1 bypasses the 60s catalog TTL — the playground's refresh
    // button and any caller that just changed a key use it to force a sweep.
    const force = /(?:^|[?&])refresh=(?:1|true)(?:&|$)/.test(url);
    const list = await modelList(opts, force);
    sendJson(res, 200, list);
    return;
  }
  if (req.method !== "POST" || path !== "/v1/chat/completions") {
    sendError(res, 404, `unknown route ${req.method ?? ""} ${path} (try /v1/chat/completions, /v1/models, /health)`, "not_found");
    return;
  }
  // The chat endpoint spends upstream keys per request — cap it per client IP
  // before any body is read or provider is touched. (The models route is
  // bounded by the catalog cache TTL instead.)
  const rate = limiter.check(req.socket.remoteAddress ?? "unknown");
  if (!rate.admitted) {
    sendError(res, 429, `rate limit exceeded — retry in ${rate.retryAfterSec}s`, "rate_limited", { "Retry-After": String(rate.retryAfterSec) });
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
  // Fully-auto requests (no pinned model) may silently hop backends on
  // retryable failures — each hop is server-logged and the winner is named in
  // serviced_by. A pinned model is consent to exactly that target: it never
  // hops, the failure is returned as-is.
  const autoRequest = requested === "" ? opts.provider === "auto" : requested === "auto";
  let target = resolveTarget(requested, { provider: opts.provider, model: opts.model });
  if ("error" in target) {
    logErrorLazy("resolve-target", `model=${JSON.stringify(requested)} err=${target.error}`);
    sendError(res, 400, target.error, "unknown_provider");
    return;
  }
  const messages = toLoopMessages(parsed.messages);
  if (messages.length === 0) {
    sendError(res, 400, "messages[] is required and must not be empty", "invalid_messages");
    return;
  }
  const stream = parsed.stream === true;
  const includeUsage =
    typeof parsed.stream_options === "object" &&
    parsed.stream_options !== null &&
    (parsed.stream_options as { include_usage?: unknown }).include_usage === true;
  // Bounded silent retry: at most AUTO_ATTEMPTS upstream calls so a fault
  // storm costs the client latency, not an infinite hang. Upstream stats are
  // recorded at the port layer, so every failed hop feeds health/cooling and
  // the next pick (and next request) routes around it.
  const tried = new Set<string>();
  let lastError = "";
  let lastRetryable = "server";
  let result: Extract<ChatPortResponse, { ok: true }> | null = null;
  for (let attempt = 0; attempt < AUTO_ATTEMPTS; attempt++) {
    const cfg = getProviderConfig(target.provider);
    if (cfg === null) {
      logErrorLazy("unknown-provider", `provider=${target.provider}`);
      sendError(res, 400, `unknown provider "${target.provider}"`, "unknown_provider");
      return;
    }
    // Deny-by-default consent gate: every target — explicit, server-default,
    // or auto-hop — must name an enabled model before a key is resolved.
    if (!isModelAllowed(target.provider, target.model)) {
      const id = `${target.provider}:${target.model}`;
      logErrorLazy("model-not-enabled", `model=${id}`);
      sendError(
        res,
        403,
        `model "${id}" is not enabled — ${opts.authUi === true ? `enable it at /auth#prov-${target.provider} or run:` : "start serve with --auth-ui to manage the allowlist, or run:"} codewhip provider enable ${id}`,
        "model_not_enabled",
      );
      return;
    }
    const key = resolveKey(target.provider);
    if (key.key.length === 0) {
      logErrorLazy("missing-key", `provider=${target.provider}`);
      sendError(res, 401, `no key for "${target.provider}" — set ${cfg.envVar} or run: codewhip auth login ${target.provider}`, "missing_provider_key");
      return;
    }
    const port = makePortForConfig(cfg, key.key, undefined, key.source);
    // ^^^ keySource must be passed: anonymous providers (kilo,
    // opencode, llm7) must NOT get a Bearer token in the
    // Authorization header — see openAiPort's auth header rule above.
    const attemptResult = await port({ model: target.model, messages, tools: toToolSpecs(parsed.tools) });
    if (attemptResult.ok) {
      result = attemptResult;
      break;
    }
    logErrorLazy("turn-failed", `provider=${target.provider} model=${target.model} retryable=${attemptResult.retryable} err=${attemptResult.error}`);
    lastError = attemptResult.error;
    lastRetryable = attemptResult.retryable;
    if (!autoRequest || (attemptResult.retryable !== "rate-limited" && attemptResult.retryable !== "timeout" && attemptResult.retryable !== "server")) {
      sendError(res, statusForError(attemptResult.retryable), attemptResult.error, attemptResult.retryable);
      return;
    }
    tried.add(`${target.provider}:${target.model}`);
    const next = pickAutoTarget(tried);
    if ("error" in next) {
      sendError(res, statusForError(lastRetryable), lastError, lastRetryable);
      return;
    }
    target = next;
  }
  if (result === null) {
    sendError(res, statusForError(lastRetryable), lastError, lastRetryable);
    return;
  }
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt: result.promptTokens, completion: result.completionTokens };
  const servicedBy = `${target.provider}:${target.model}`;
  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    writeSyntheticStream(res, id, target.model, created, result.text, result.toolCalls, usage, includeUsage, servicedBy);
    res.end();
    return;
  }
  sendJson(res, 200, {
    id,
    object: "chat.completion",
    created,
    model: target.model,
    serviced_by: servicedBy,
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
  if (!isLoopback(opts.host) && !opts.token) {
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
    console.log(`  GET  /v1/models             (${listAllProviderConfigs().length} providers, live-catalog "<provider>:<model>" rows${opts.pingModels ? ", ping-filtered" : ""}, 60s cache)`);
    console.log(`  GET  /health`);
    console.log(`  GET  /playground            model playground UI`);
    console.log(`  GET  /stats                 aggregated provider health (no per-request history)`);
    if (opts.authUi) {
      console.log(`  GET  /auth                  provider key manager UI (register a custom endpoint there too)`);
    }
    console.log(`  default route: ${opts.provider}:${opts.model}`);
    const enabled = loadAllowedEntries();
    if (enabled.length === 0) {
      console.log(`  !! allowlist EMPTY — NOTHING is enabled. ${opts.authUi === true ? "Visit /auth to enable models one by one," : "Start with --auth-ui for the model manager,"} or: codewhip provider enable <provider>:<model>`);
    } else {
      console.log(`  allowlist: ${enabled.length} model(s) enabled (deny by default — manage at ${opts.authUi === true ? "/auth" : "codewhip provider enable/disable"})`);
    }
    console.log(`  auth: ${opts.token ? "bearer token required" : "none (loopback only)"}`);
    console.log(`  note: this proxies models — it runs no tools, applies no policy, and writes no audit entries.`);
    console.log(`  stop with Ctrl-C (press again to force).`);
  });
  return server;
}
