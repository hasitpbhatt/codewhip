import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { addCustomProvider, getProviderConfig, isLoopbackBaseUrl, listAllProviderConfigs, removeCustomProvider } from "./custom-providers.js";
import { isBuiltinProviderId, makePortForConfig, PROVIDERS, type ProviderId } from "./provider.js";
import { resolveKey, saveKey, clearKey } from "./auth.js";
import type { LoopMsg, LoopToolCall, ToolSpec } from "./provider-port.js";
import { readProviderCalls, summarizeCalls } from "./provider-stats.js";
import { estimateCost, isAutoEligible, isRecentlyFailed } from "./router.js";

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
 * model id on the server's default provider.
 */
/**
 * Health-weighted auto pick for `model: "auto"` (and `--provider auto`).
 * Eligibility (loopback / key / paid-key gates) is `isAutoEligible` in the
 * router — one rule for CLI and serve, so a paid key is never auto-touched.
 * On top: TTL deactivation plus a success-rate floor, then weight drains the
 * known-$0 pool first: free ×3, priced ×1, untracked ×0.5 (opt-in only),
 * times (0.5 + successRate) so a proven model beats an unproven one without
 * starving new providers. No-data providers keep full weight — empty history
 * is not failure.
 */
function pickAutoTarget(): Target | { error: string } {
  const summary = summarizeCalls(readProviderCalls());
  const cands: Array<{ provider: string; model: string; weight: number }> = [];
  for (const cfg of listAllProviderConfigs()) {
    if (!isAutoEligible(cfg.id, cfg.defaultModel)) continue;
    if (isRecentlyFailed(cfg.id, cfg.defaultModel)) continue;
    const mh = summary.providers.find((p) => p.provider === cfg.id)?.models.find((m) => m.model === cfg.defaultModel);
    if (mh !== undefined && mh.total >= 5 && mh.successRate < 0.5) continue;
    const per1k = estimateCost(cfg.id as ProviderId, cfg.defaultModel, 1000, 1000);
    const costFactor = per1k === null ? 0.5 : per1k === 0 ? 3 : 1;
    const healthFactor = mh === undefined ? 1.5 : 0.5 + mh.successRate;
    cands.push({ provider: cfg.id, model: cfg.defaultModel, weight: costFactor * healthFactor });
  }
  if (cands.length === 0) {
    return { error: "auto: no healthy free provider/model combos available — pass an explicit model, add a key for a $0 route, or set CODEWHIP_AUTO_INCLUDE_UNTRACKED=1 to let auto use untracked-cost providers" };
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

async function modelList(opts: ServeOptions): Promise<Record<string, unknown>> {
  const created = Math.floor(Date.now() / 1000);
  const cfgs = listAllProviderConfigs();
  let rows = cfgs.map((cfg) => ({
    id: `${cfg.id}:${cfg.defaultModel}`,
    object: "model" as const,
    created,
    owned_by: cfg.id,
    cfg,
  }));
  if (opts.pingModels) {
    const ping = async (cfg: typeof cfgs[number]) => {
      try {
        const url = `${cfg.baseUrl}${cfg.modelsPath}`;
        const { key } = resolveKey(cfg.id);
        const headers: Record<string, string> = {};
        if (key.length > 0) headers["Authorization"] = `Bearer ${key}`;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 1500);
        const res = await fetch(url, { method: "GET", signal: controller.signal, headers });
        clearTimeout(t);
        if (!res.ok) return false;
        const data = await res.json().catch(() => null) as { data?: Array<{ id: string }> } | null;
        if (!data?.data) return true; // list shape unknown, assume reachable
        return data.data.some((m) => m.id === cfg.defaultModel);
      } catch {
        return false;
      }
    };
    const results = await Promise.all(rows.map(async (r) => ({ r, ok: await ping(r.cfg) })));
    rows = results.filter((x) => x.ok).map((x) => x.r);
  }
  const data = rows.map(({ cfg: _cfg, ...rest }) => rest);
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
  return listAllProviderConfigs().map((cfg) => {
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
    };
  });
}

function authHtml(): string {
  const rows = authStatus().map(r => {
    const id = escapeHtml(r.id);
    const endpoint = r.custom === true ? `<div class="url">${escapeHtml(r.baseUrl)}</div>` : "";
    const keyUrl = String(r.keyUrl).length > 0 ? `<a href="${escapeHtml(r.keyUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.keyUrl)}</a>` : `<span class="none">(none)</span>`;
    const tag = r.custom === true ? `<span class="tag">custom</span>` : "";
    const keyState = r.hasKey ? `<span class="pill ok">key set</span>` : `<span class="pill">no key</span>`;
    const source = escapeHtml(r.source);
    const env = escapeHtml(r.envVar);
    return `<div class="card prov">
<div class="prov-head">
<div>
<strong>${id}</strong>${tag}
${endpoint}
</div>
<div class="prov-actions">
${keyState}
<button data-act="login" data-id="${id}">Set key</button>
${r.hasKey ? `<button data-act="logout" data-id="${id}" class="ghost">Remove key</button>` : ``}
${r.custom ? `<button data-act="remove" data-id="${id}" class="danger">Remove provider</button>` : ``}
</div>
</div>
<div class="prov-meta">
<div><span class="k">Env</span><code>${env}</code></div>
<div><span class="k">Key console</span>${keyUrl}</div>
<div><span class="k">Source</span><span class="src">${source}</span></div>
</div>
</div>`;
  }).join("");
  return `<!doctype html><html lang=en><head><meta charset=utf-8><title>codewhip auth</title><style>
:root{--bg:#fafafa;--fg:#111;--muted:#666;--border:#ddd;--card:#fff;--accent:#0a7bff;--danger:#d00}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e6e6;--muted:#9aa;--border:#333;--card:#161a21;--accent:#4da3ff}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
header{padding:1rem 1.5rem;border-bottom:1px solid var(--border);background:var(--card);position:sticky;top:0}
h1{margin:0;font-size:1.2rem;font-weight:600}
.container{max-width:1000px;margin:0 auto;padding:1.5rem}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
@media (max-width:900px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem}
.prov{margin-bottom:1rem}
.prov-head{display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;align-items:flex-start}
.prov-actions{display:flex;gap:.5rem;align-items:center}
.prov-meta{display:grid;grid-template-columns:140px 1fr;gap:.5rem;margin-top:.75rem;color:var(--muted);font-size:.92rem}
.prov-meta .k{font-weight:600;color:var(--fg)}
code{background:var(--bg);padding:.15rem .35rem;border-radius:4px;border:1px solid var(--border)}
.tag{background:#eef;border:1px solid #ccd;color:#446;border-radius:3px;font-size:.7em;padding:.05rem .25rem;margin-left:.5rem}
.pill{display:inline-block;padding:.15rem .5rem;border-radius:999px;background:var(--border);font-size:.75rem;margin-right:.5rem}
.pill.ok{background:#e6f4ea;color:#137333}
.url{font-size:.8em;color:var(--muted);word-break:break-all}
.none{opacity:.6}
button{cursor:pointer;padding:.5rem .8rem;border:1px solid var(--border);border-radius:8px;background:var(--accent);color:#fff;font-weight:600}
button.ghost{background:transparent;color:var(--fg)}
button.danger{background:transparent;color:var(--danger);border-color:var(--danger)}
input{width:100%;padding:.6rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
label{display:block;font-weight:600;margin:.6rem 0 .25rem}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:.75rem}
@media (max-width:700px){.form-grid{grid-template-columns:1fr}}
.err{color:var(--danger);min-height:1.2em;margin:.5rem 0}
small{color:var(--muted)}
</style></head><body>
<header><h1>codewhip auth — providers & keys</h1></header>
<div class="container">
<div class="grid">
<div>
<h2 style="margin:.5rem 0 1rem">Your providers</h2>
${rows}
</div>
<div>
<div class="card">
<h3 style="margin-top:0">Register custom endpoint</h3>
<form id="add" autocomplete="off" class="form-grid">
<div><label>id</label><input name="id" required placeholder="my-gateway"></div>
<div><label>base URL</label><input name="baseUrl" required placeholder="https://gateway.example.com"></div>
<div><label>default model</label><input name="model" required placeholder="my-model"></div>
<div><label>env var</label><input name="envVar" required placeholder="MY_GATEWAY_API_KEY"></div>
<div style="grid-column:1/-1"><label>key URL</label><input name="keyUrl" placeholder="https://gateway.example.com/keys"></div>
<div style="grid-column:1/-1"><label>API key <span style="font-weight:400;color:var(--muted)">optional – provide now instead of env var</span></label><input name="key" type="password" autocomplete="new-password" placeholder="sk-..."></div>
<details style="grid-column:1/-1"><summary>Optional</summary>
<div class="form-grid" style="margin-top:.5rem">
<div><label>brand</label><input name="brand"></div>
<div><label>chat path</label><input name="chatPath" placeholder="/v1/chat/completions"></div>
<div><label>models path</label><input name="modelsPath" placeholder="/v1/models"></div>
<div><label>timeout ms</label><input name="timeoutMs" inputmode="numeric"></div>
<div><label>rate hint</label><input name="rateHint"></div>
</div>
</details>
<div class="err" id="err"></div>
<button type="submit" style="margin-top:.5rem">Register</button>
</form>
<p><small>https:// anywhere, http:// on loopback for local runtimes like Ollama. Ids: lowercase letters, digits, dashes.</small></p>
</div>
</div>
</div>
</div>
<script>
const err=document.getElementById('err');
document.getElementById('add').addEventListener('submit',async e=>{
  e.preventDefault();
  const fd=new FormData(e.target);
  const key=String(fd.get('key')||'').trim();
  const body={}; fd.forEach((v,k)=>{if(k==='key') return; const s=String(v).trim(); if(s) body[k]=s;});
  err.textContent='';
  try{
    const res=await fetch('/auth/_custom',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!res.ok){const j=await res.json().catch(()=>null); err.textContent=(j&&j.error&&j.error.message)||('failed '+res.status); return;}
    if(key){await fetch('/auth/'+encodeURIComponent(body.id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key})});}
    location.reload();
  }catch(e2){err.textContent='network error';}
});
document.addEventListener('click',async e=>{
  const b=e.target.closest('button[data-act]'); if(!b) return;
  const id=b.dataset.id, act=b.dataset.act;
  if(act==='login'){const k=prompt('Enter '+id+' API key'); if(k===null) return; await fetch('/auth/'+encodeURIComponent(id),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key:k})}); location.reload();}
  if(act==='logout'){if(!confirm('Remove stored '+id+' key?')) return; await fetch('/auth/'+encodeURIComponent(id),{method:'DELETE'}); location.reload();}
  if(act==='remove'){if(!confirm('Remove custom provider '+id+'?')) return; const res=await fetch('/auth/_custom/'+encodeURIComponent(id),{method:'DELETE'}); if(!res.ok){alert('failed');} else {location.reload();}}
});
</script></body></html>`;
}

function playgroundHtml(): string {
  return `<!doctype html><html lang=en><head><meta charset=utf-8><title>codewhip playground</title><style>
:root{--bg:#fafafa;--fg:#111;--muted:#666;--border:#ddd;--card:#fff;--accent:#0a7bff;--danger:#d00}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e6e6;--muted:#9aa;--border:#333;--card:#161a21;--accent:#4da3ff}}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Arial,sans-serif;background:var(--bg);color:var(--fg);line-height:1.5}
header{padding:1rem 1.5rem;border-bottom:1px solid var(--border);background:var(--card);position:sticky;top:0;z-index:10}
h1{margin:0;font-size:1.2rem;font-weight:600}
.container{max-width:1100px;margin:0 auto;padding:1.5rem;display:grid;grid-template-columns:360px 1fr;gap:1.5rem}
@media (max-width:900px){.container{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--border);border-radius:10px;padding:1rem}
label{display:block;font-weight:600;margin:.75rem 0 .35rem;color:var(--fg)}
select,input,textarea,button{font:inherit}
select,input[type=text],textarea{width:100%;padding:.6rem;border:1px solid var(--border);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:100px;resize:vertical}
.row{display:grid;grid-template-columns:1fr;gap:.5rem}
.actions{display:flex;gap:.5rem;align-items:center;margin-top:.75rem}
button{cursor:pointer;padding:.55rem .9rem;border:1px solid var(--border);border-radius:8px;background:var(--accent);color:#fff;font-weight:600}
button.secondary{background:transparent;color:var(--fg)}
button:disabled{opacity:.5;cursor:not-allowed}
.switch{display:flex;align-items:center;gap:.5rem;font-weight:400;color:var(--muted)}
.output{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:1rem;min-height:420px;white-space:pre-wrap;overflow:auto;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.92rem}
.status{font-size:.85rem;color:var(--muted);margin:.5rem 0}
.error{color:var(--danger);font-weight:600}
.collapser{cursor:pointer;color:var(--accent);font-size:.9rem;margin:.25rem 0}
.hidden{display:none}
.badge{display:inline-block;padding:.15rem .45rem;border-radius:6px;background:var(--border);font-size:.75rem;margin-left:.5rem;color:var(--muted)}
</style></head><body>
<header><h1>codewhip playground</h1></header>
<div class="container">
<div class="card">
<div class="row">
<label for="model">Model <span id="modelBadge" class="badge">loading…</span></label>
<select id="model"></select>
<p class="status">Choose a provider:model from /v1/models</p>
</div>
<div class="row">
<label for="system" class="collapser" id="sysToggle">System ▾</label>
<textarea id="system" class="hidden" placeholder="Optional system prompt"></textarea>
</div>
<div class="row">
<label for="prompt">Prompt</label>
<textarea id="prompt" placeholder="Type a prompt…"></textarea>
</div>
<div class="actions">
<div class="switch"><input type="checkbox" id="stream" checked> <span>Stream</span></div>
<button id="send">Send</button>
<button class="secondary" id="stop">Stop</button>
<button class="secondary" id="clear">Clear</button>
</div>
<div id="err" class="error status"></div>
</div>
<div class="card">
<div class="status">Output</div>
<div id="chat" class="output" aria-live="polite"></div>
</div>
</div>
<script>
const $ = s=>document.querySelector(s);
const modelSel=$('#model'), sys=$('#system'), promptEl=$('#prompt'), streamEl=$('#stream');
const chat=$('#chat'), err=$('#err'), badge=$('#modelBadge');
let controller=null;
async function loadModels(){
  try{
    const res=await fetch('/v1/models');
    const j=await res.json();
    modelSel.innerHTML='';
    (j.data||[]).forEach(m=>{
      const o=document.createElement('option');
      o.value=m.id; o.textContent=m.id;
      modelSel.appendChild(o);
    });
    badge.textContent=(j.data?.length||0)+' models';
  }catch(e){badge.textContent='offline';}
}
loadModels();
$('#sysToggle').addEventListener('click',()=>{sys.classList.toggle('hidden'); $('#sysToggle').textContent=sys.classList.contains('hidden')?'System ▾':'System ▴';});
$('#clear').addEventListener('click',()=>{chat.textContent=''; err.textContent='';});
$('#stop').addEventListener('click',()=>{if(controller){controller.abort(); controller=null; err.textContent='Stopped';}});
async function send(){
  err.textContent=''; chat.textContent='';
  const model=modelSel.value, system=sys.value.trim(), prompt=promptEl.value.trim();
  if(!model){err.textContent='Select a model'; modelSel.focus(); return;}
  if(!prompt){err.textContent='Enter a prompt'; promptEl.focus(); return;}
  const messages=[]; if(system) messages.push({role:'system',content:system}); messages.push({role:'user',content:prompt});
  controller=new AbortController();
  try{
    const res=await fetch('/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model,messages,stream:streamEl.checked}),signal:controller.signal});
    if(!res.ok){err.textContent='Error '+res.status; return;}
    if(streamEl.checked){
      const reader=res.body.getReader(), dec=new TextDecoder(); let buf='';
      while(true){const {value,done}=await reader.read(); if(done) break; buf+=dec.decode(value,{stream:true}); const lines=buf.split('\\n'); buf=lines.pop(); for(const line of lines){if(!line.startsWith('data:')) continue; const data=line.slice(5).trim(); if(data==='[DONE]') continue; try{const j=JSON.parse(data); const c=j.choices?.[0]?.delta?.content; if(c) chat.textContent+=c;}catch{}} }
    }else{const j=await res.json(); chat.textContent=j.choices?.[0]?.message?.content ?? '';}
  }catch(e){if(e.name!=='AbortError') err.textContent='Network error';}
  finally{controller=null;}
}
$('#send').addEventListener('click',send);
promptEl.addEventListener('keydown',e=>{if(e.key==='Enter'&&e.metaKey){e.preventDefault();send();}});
</script>
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

async function handleAuthUi(req: http.IncomingMessage, res: http.ServerResponse, path: string): Promise<boolean> {
  if (!path.startsWith(AUTH_UI)) return false;
  const rest = path.slice(AUTH_UI.length); // "" | "/<id>" | "/_custom" | "/_custom/<id>"
  if (rest === CUSTOM_PATH || rest.startsWith(`${CUSTOM_PATH}/`)) {
    await handleCustomRoutes(req, res, rest.slice(CUSTOM_PATH.length));
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
  const cfg = builtin ?? custom!;
  if (req.method === "GET") {
    const { key, source } = resolveKey(id);
    sendJson(res, 200, { id, envVar: cfg.envVar, source, hasKey: key.length > 0 });
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
    sendJson(res, 200, { id, source: "file" });
    return true;
  }
  if (req.method === "DELETE") {
    clearKey(id);
    sendJson(res, 200, { id, source: resolveKey(id).source });
    return true;
  }
  sendError(res, 405, `method ${req.method ?? ""} not allowed on /auth`, "method_not_allowed");
  return true;
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
  // Only /health is public (load-balancer checks must work without the
  // bearer). Everything else — playground, the auth UI/API, /v1/* — sits
  // behind the token when one is configured: the auth UI spends your keys.
  // There is deliberately no /stats here: per-request history stays out of
  // the proxy entirely (see `codewhip stats` for the local CLI view).
  if (opts.token !== undefined) {
    if (!bearerMatches(req.headers.authorization, opts.token)) {
      sendError(res, 401, "missing or invalid bearer token for this server", "invalid_api_key");
      return;
    }
  }
  if (req.method === "GET" && path === "/playground") {
    sendHtml(res, playgroundHtml());
    return;
  }
  if (opts.authUi && path.startsWith(AUTH_UI)) {
    await handleAuthUi(req, res, path);
    return;
  }
  if (req.method === "GET" && path === "/v1/models") {
    const list = await modelList(opts);
    sendJson(res, 200, list);
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
    console.log(`  GET  /v1/models             (${listAllProviderConfigs().length} providers as "<provider>:<default-model>"${opts.pingModels ? ", ping-filtered" : ""})`);
    console.log(`  GET  /health`);
    console.log(`  GET  /playground            model playground UI`);
    if (opts.authUi) {
      console.log(`  GET  /auth                  provider key manager UI (register a custom endpoint there too)`);
    }
    console.log(`  default route: ${opts.provider}:${opts.model}`);
    console.log(`  auth: ${opts.token !== undefined ? "bearer token required" : "none (loopback only)"}`);
    console.log(`  note: this proxies models — it runs no tools, applies no policy, and writes no audit entries.`);
    console.log(`  stop with Ctrl-C (press again to force).`);
  });
  return server;
}
