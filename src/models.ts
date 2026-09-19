import { candidateBaseUrls, pinHost, resolveBaseUrl, unresolvedBaseUrlVars } from "./provider.js";
import { recordProviderCall, outcomeForStatus, LISTING_MODEL } from "./provider-stats.js";
import { getProviderConfig } from "./custom-providers.js";

const MODELS_TIMEOUT_MS = 15000;

/** Agency verdicts are earned by live probes, not by the listing endpoint. */
export type AgencyTag = "agent" | "agent (reasoning)" | "completion-only" | "non-chat" | "untested";

export type AnnotatedModel = {
  id: string;
  tag: AgencyTag;
  note: string;
  isDefault: boolean;
};

/** Prefix rules distilled from docs + live probes. Evidence dates are set
 *  only when a probe actually exercised the tool loop; everything else says
 *  "untested" honestly (a listing endpoint cannot prove agency). */
export function annotateModel(provider: string, id: string): { tag: AgencyTag; note: string } {
  const def = getProviderConfig(provider)?.defaultModel;
  if (provider === "nvidia") {
    if (id === def) {
      return { tag: "agent", note: "codewhip default; ran the tool loop in testing (2026-09-08)" };
    }
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "alibaba") {
    if (id.startsWith("qwen")) {
      return {
        tag: "untested",
        note: id === def
          ? "codewhip default; documented tool-caller, no live probe yet"
          : "documented tool-caller, no live probe yet",
      };
    }
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "sensenova") {
    return {
      tag: "untested",
      note: id === def
        ? "codewhip default; agency unknown (no live probe yet)"
        : "served; agency unknown",
    };
  }
  if (provider === "llm7") {
    return {
      tag: "untested",
      note: id === def
        ? "llm7 gateway default; OpenAI-compatible, no live probe yet"
        : "served via llm7 gateway; agency unknown",
    };
  }
  if (provider === "tokenharbor") {
    return {
      tag: "untested",
      note: id === def
        ? "tokenharbor orchestrator default; OpenAI-compatible, no live probe yet"
        : "served via tokenharbor gateway; agency unknown",
    };
  }
  if (provider === "bai") {
    return {
      tag: "untested",
      note: id === def
        ? "bai gateway default (pricing-table pick; OpenAI-compatible, no live probe yet)"
        : "served via bai gateway; agency unknown",
    };
  }
  if (provider === "fabryka") {
    return {
      tag: "untested",
      note: id === def
        ? "fabryka router default (qwen reasoning model; no live probe yet)"
        : "served via fabryka router; agency unknown",
    };
  }
  if (provider === "kilo") {
    return {
      tag: "untested",
      note: id === def
        ? "codewhip default; ':free' models anonymous; a tool-call round verified 2026-09-11, no full agent-loop probe"
        : "served; ':free' models anonymous; listing verified live 2026-09-11; agency unknown",
    };
  }
  if (provider === "opencode") {
    return {
      tag: "untested",
      note: "zen free tier verified keyless 2026-09-11 (identity-header gated, small per-IP quota); no tool-loop probe yet",
    };
  }
  if (provider === "groq" || provider === "zai" || provider === "openrouter") {
    return { tag: "untested", note: "listing verified live 2026-09-11; no tool-loop probe yet" };
  }
  if (provider === "cerebras" || provider === "gemini") {
    return { tag: "untested", note: "docs-verified; no live probe" };
  }
  if (provider === "empero") {
    return { tag: "untested", note: "free endpoint; in maintenance (http 503) at the 2026-09-11 probe; untested" };
  }
  if (id.includes("embed")) return { tag: "non-chat", note: "embeddings only" };
  if (id.startsWith("mistral-ocr")) return { tag: "non-chat", note: "ocr only" };
  if (id.startsWith("mistral-moderation")) return { tag: "non-chat", note: "moderation only" };
  if (id.startsWith("voxtral")) return { tag: "non-chat", note: "audio only" };
  if (id.startsWith("codestral")) return { tag: "completion-only", note: "serves but refused file agency when probed (2026-09-10)" };
  if (id.startsWith("ministral")) {
    return id.endsWith("14b-latest")
      ? { tag: "agent", note: "small/fast family; tool loop probed on 14b (2026-09-10)" }
      : { tag: "agent", note: "small/fast family; documented tool-caller" };
  }
  // mistral-small/medium/magistral: vendor-documented tool-callers but the
  // free tier 429'd all live loops today — gated to "untested" until a probe
  // clears, not marketing-grade "agent".
  if (id.startsWith("mistral-small")) {
    return id === def
      ? { tag: "untested", note: "codewhip default; documented tool-caller, live probes 429-gated (2026-09-10)" }
      : { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" };
  }
  if (id.startsWith("mistral-medium")) return { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" };
  if (id.startsWith("magistral")) return { tag: "untested", note: "reasoning family; 429-gated, no live probe (2026-09-10)" };
  return { tag: "untested", note: "served; agency unknown" };
}

export type ModelsResult =
  | { ok: true; models: AnnotatedModel[] }
  | { ok: false; error: string };

function defaultFor(provider: string): string {
  return getProviderConfig(provider)?.defaultModel ?? "";
}

/** One read-only listing call. Never throws — failures return a string.
 *  `timeoutMs` lets the serve path probe catalogs on a tighter budget than
 *  the CLI's default. */
export async function listModels(provider: string, apiKey: string, timeoutMs = MODELS_TIMEOUT_MS): Promise<ModelsResult> {
  if (apiKey.length === 0) {
    return { ok: false, error: "missing api key" };
  }
  const cfg = getProviderConfig(provider);
  if (cfg === null) {
    return { ok: false, error: `unknown provider "${provider}" (see: codewhip provider list)` };
  }
  // 1min.ai's listing is not OpenAI-shaped (`GET /models?feature=…` returns a
  // different envelope than {data:[{id}]}) and the adapter has no translator
  // for it, so say so plainly instead of reporting a confusing shape error.
  if (cfg.port === "onemin") {
    return { ok: false, error: `${provider} has no model listing — set the id by hand (default: ${cfg.defaultModel})` };
  }
  // Account-scoped base URLs (Cloudflare) need their id env var before the
  // path is valid — say so instead of returning a 404-shaped model error.
  const missingVars = unresolvedBaseUrlVars(cfg.baseUrl);
  if (missingVars.length > 0) {
    return { ok: false, error: `${provider} needs ${missingVars.join(", ")} set (account-scoped base url)` };
  }
  // Try each candidate host; fall back to the next only on auth rejection, and
  // pin the first host that serves a model list (sticky across runs).
  const hosts = candidateBaseUrls(cfg);
  let lastError = "";
  for (const host of hosts) {
    const url = `${resolveBaseUrl(host)}${cfg.modelsPath}`;
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        lastError = `${provider} models listing timed out after ${timeoutMs}ms`;
        if (hosts.length > 1) continue;
        recordProviderCall({ ts: new Date().toISOString(), provider, model: LISTING_MODEL, kind: "models", outcome: "timeout", host, error: lastError.slice(0, 120) });
        return { ok: false, error: lastError };
      }
      lastError = `network error: ${err instanceof Error ? err.message : "fetch failed"}`;
      if (hosts.length > 1) continue;
      recordProviderCall({ ts: new Date().toISOString(), provider, model: LISTING_MODEL, kind: "models", outcome: "network", host, error: lastError.slice(0, 120) });
      return { ok: false, error: lastError };
    }
    if (res.ok) {
      if (host !== cfg.baseUrl) {
        pinHost(provider, host);
      }
      recordProviderCall({ ts: new Date().toISOString(), provider, model: LISTING_MODEL, kind: "models", outcome: "ok", host, status: res.status });
      let data: unknown;
      try {
        data = (await res.json()) as unknown;
      } catch {
        return { ok: false, error: `${provider} models listing returned invalid JSON` };
      }
      const rows = (data as { data?: unknown }).data;
      if (!Array.isArray(rows)) {
        return { ok: false, error: `${provider} models listing returned an unexpected shape` };
      }
      const ids = [...new Set(rows.flatMap((r) => (typeof (r as { id?: unknown }).id === "string" ? [(r as { id: string }).id] : [])))].sort();
      const fallback = defaultFor(provider);
      return {
        ok: true,
        models: ids.map((id) => ({ id, ...annotateModel(provider, id), isDefault: id === fallback })),
      };
    }
    if (res.status === 401 || res.status === 403) {
      lastError = `invalid ${provider} key (never printed or logged)`;
      if (hosts.length > 1) continue;
      recordProviderCall({ ts: new Date().toISOString(), provider, model: LISTING_MODEL, kind: "models", outcome: "auth", host, status: res.status, error: lastError.slice(0, 120) });
      return { ok: false, error: lastError };
    }
    if (res.status === 429) {
      recordProviderCall({ ts: new Date().toISOString(), provider, model: LISTING_MODEL, kind: "models", outcome: "quota", host, status: res.status });
      return { ok: false, error: `${provider} rate limited — the listing shares your quota, retry later` };
    }
    lastError = `${provider} models listing failed (http ${res.status})`;
    if (hosts.length > 1) continue;
    recordProviderCall({ ts: new Date().toISOString(), provider, model: LISTING_MODEL, kind: "models", outcome: outcomeForStatus(res.status, lastError.slice(0, 120)), host, status: res.status, error: lastError.slice(0, 120) });
    return { ok: false, error: lastError };
  }
  return { ok: false, error: lastError || `${provider} models listing failed` };
}
