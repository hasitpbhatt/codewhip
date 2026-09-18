/**
 * Provider registry facade for the CodeWhip library (Workers-compatible).
 *
 * The provider table and the free chain are pure data and live in
 * Node-free leaves shared with the CLI:
 *
 *   src/provider-registry.ts — BuiltinProviderId/ProviderConfig + the table
 *   src/free-chain.ts        — the ordered --free hop list
 *
 * This file used to carry its own fork of both. Forks drift (this one sat
 * 20 providers and one free-chain prune behind the CLI), so the data now
 * flows one way: CLI and lib import the same rows. What remains here is the
 * library-facing helpers over that shared data: lookup helpers, the
 * key-filtered free-provider view, and model discovery with agency
 * annotations.
 */

import { PROVIDERS as BUILTIN_PROVIDERS, PROVIDER_IDS } from "../provider-registry.js";
import { FREE_CHAIN as BUILTIN_FREE_CHAIN } from "../free-chain.js";
import type { ProviderConfig, ProviderId } from "./types.js";

export { isBuiltinProviderId } from "../provider-registry.js";

// ============================================================================
// Agency Types
// ============================================================================

export type AgencyTag = "agent" | "agent (reasoning)" | "completion-only" | "non-chat" | "untested";

export interface AnnotatedModel {
  id: string;
  tag: AgencyTag;
  note: string;
  isDefault: boolean;
}

export type ModelsResult =
  | { ok: true; models: AnnotatedModel[] }
  | { ok: false; error: string };

// ============================================================================
// Builtin Provider Registry (shared with the CLI — single source of truth)
// ============================================================================

/**
 * The shared builtin table, widened from the CLI's `Record<BuiltinProviderId,
 * …>` to `Record<ProviderId, …>` for storage/router lookups by arbitrary
 * (including custom) ids. Object.fromEntries erases the literal keys; the
 * row values satisfy the library's ProviderConfig structurally.
 */
export const PROVIDERS: Record<ProviderId, ProviderConfig> = Object.fromEntries(
  Object.entries(BUILTIN_PROVIDERS)
);

export function getProviderConfig(id: ProviderId): ProviderConfig | undefined {
  return PROVIDERS[id];
}

export function listBuiltinProviderIds(): ProviderId[] {
  return [...PROVIDER_IDS];
}

export function listBuiltinProviderConfigs(): ProviderConfig[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]);
}

// ============================================================================
// Free Chain (for --free runs) — shared with the CLI
// ============================================================================

export type FreeProviderEntry = {
  id: ProviderId;
  freeOffer: string;
  keyNeeded: "no" | "free-key";
  limits: string;
};

/** The same ordered chain the CLI runs — keyless tiers first, llm7 floor last. */
export const FREE_CHAIN: readonly FreeProviderEntry[] = BUILTIN_FREE_CHAIN;

export function freeChainIds(): ProviderId[] {
  return FREE_CHAIN.map((e) => e.id);
}

export function listFreeProviders(resolveKey: (id: string) => { key: string; source: string }): FreeProviderEntry[] {
  return FREE_CHAIN.filter((e) => resolveKey(e.id).key.length > 0);
}

// ============================================================================
// Model Discovery & Agency Annotations
// ============================================================================

const MODELS_TIMEOUT_MS = 15000;

const AGENCY_NOTES: Record<string, { tag: AgencyTag; note: string }> = {
  // nvidia
  "meta/llama-3.1-405b-instruct": { tag: "agent", note: "ran the tool loop in testing (2026-09-08)" },
  // alibaba
  "qwen-plus": { tag: "untested", note: "documented tool-caller, no live probe yet" },
  // sensenova
  "sensenova-6.8-flash-lite": { tag: "untested", note: "agency unknown (no live probe yet)" },
  // llm7
  "deepseek-v3": { tag: "untested", note: "llm7 gateway default; OpenAI-compatible, no live probe yet" },
  // kilo
  "cohere/north-mini-code:free": { tag: "untested", note: "':free' models anonymous; a tool-call round verified 2026-09-11, no full agent-loop probe" },
  // opencode
  "mimo-v2.5-free": { tag: "untested", note: "zen free tier verified keyless 2026-09-11 (identity-header gated, small per-IP quota); no tool-loop probe yet" },
  // mistral
  "ministral-14b-latest": { tag: "agent", note: "small/fast family; tool loop probed on 14b (2026-09-10)" },
  "mistral-small-latest": { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" },
  "mistral-medium-latest": { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" },
  "magistral-small-2506": { tag: "untested", note: "reasoning family; 429-gated, no live probe (2026-09-10)" },
  // community gateways
  "anyrouter/free": { tag: "untested", note: "community gateway free tier; 184+ models, stability varies" },
  "gpt/5.6-luna": { tag: "untested", note: "APInex paid aggregator; $0.07/1M tokens" },
};

function annotateModel(provider: string, id: string): { tag: AgencyTag; note: string } {
  // Check specific known models first
  if (AGENCY_NOTES[id]) return AGENCY_NOTES[id];

  const def = PROVIDERS[provider]?.defaultModel;

  // Provider-level defaults
  if (provider === "nvidia") {
    if (id === def) return { tag: "agent", note: "ran the tool loop in testing (2026-09-08)" };
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "alibaba") {
    if (id.startsWith("qwen")) {
      return { tag: "untested", note: "documented tool-caller, no live probe yet" };
    }
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "mistral") {
    return { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" };
  }
  if (provider === "kilo") {
    return { tag: "untested", note: "':free' models anonymous; listing verified live 2026-09-11; agency unknown" };
  }
  if (provider === "opencode") {
    return { tag: "untested", note: "zen free tier verified keyless 2026-09-11 (identity-header gated, small per-IP quota); no tool-loop probe yet" };
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

  // Model-type heuristics
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
  if (id.startsWith("mistral-small") || id.startsWith("mistral-medium") || id.startsWith("magistral")) {
    return { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" };
  }

  return { tag: "untested", note: "served; agency unknown" };
}

/** One read-only listing call. Never throws — failures return a string. */
export async function listModels(
  provider: string,
  apiKey: string,
  resolveBaseUrl: (baseUrl: string) => string,
  unresolvedVars: (baseUrl: string) => string[],
  timeoutMs = MODELS_TIMEOUT_MS
): Promise<ModelsResult> {
  if (apiKey.length === 0) {
    return { ok: false, error: "missing api key" };
  }
  const cfg = PROVIDERS[provider];
  if (!cfg) {
    return { ok: false, error: `unknown provider "${provider}"` };
  }
  if (cfg.port === "onemin") {
    return { ok: false, error: `${provider} has no model listing — set the id by hand (default: ${cfg.defaultModel})` };
  }
  const missingVars = unresolvedVars(cfg.baseUrl);
  if (missingVars.length > 0) {
    return { ok: false, error: `${provider} needs ${missingVars.join(", ")} set (account-scoped base url)` };
  }

  const url = `${resolveBaseUrl(cfg.baseUrl)}${cfg.modelsPath}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `${provider} models listing timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: `network error: ${err instanceof Error ? err.message : "fetch failed"}` };
  }

  if (res.ok) {
    recordProviderCall({ ts: new Date().toISOString(), provider, model: "(listing)", kind: "models", outcome: "ok", status: res.status });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return { ok: false, error: `${provider} models listing returned invalid JSON` };
    }
    const rows = (data as { data?: unknown }).data;
    if (!Array.isArray(rows)) {
      return { ok: false, error: `${provider} models listing returned an unexpected shape` };
    }
    const ids = [...new Set(rows.flatMap((r) => (typeof (r as { id?: unknown }).id === "string" ? [(r as { id: string }).id] : [])))].sort();
    const fallback = cfg.defaultModel;
    return {
      ok: true,
      models: ids.map((id) => ({ id, ...annotateModel(provider, id), isDefault: id === fallback })),
    };
  }
  if (res.status === 401 || res.status === 403) {
    recordProviderCall({ ts: new Date().toISOString(), provider, model: "(listing)", kind: "models", outcome: "auth", status: res.status });
    return { ok: false, error: `invalid ${provider} key (never printed or logged)` };
  }
  if (res.status === 429) {
    recordProviderCall({ ts: new Date().toISOString(), provider, model: "(listing)", kind: "models", outcome: "quota", status: res.status });
    return { ok: false, error: `${provider} rate limited — the listing shares your quota, retry later` };
  }
  recordProviderCall({ ts: new Date().toISOString(), provider, model: "(listing)", kind: "models", outcome: outcomeForStatus(res.status), status: res.status });
  return { ok: false, error: `${provider} models listing failed (http ${res.status})` };
}

// Helper function for recording (avoids circular deps with router.ts)
type ListingRecord = {
  ts: string;
  provider: string;
  model: string;
  kind: "models";
  outcome: string;
  status?: number;
};
function recordProviderCall(_rec: ListingRecord): void {
  // Best-effort; health tracking is optional here
}

export function outcomeForStatus(status: number): string {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 404 || status === 410) return "bad_model";
  if (status >= 500) return "other";
  return "other";
}
