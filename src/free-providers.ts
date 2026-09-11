import { PROVIDERS, type BuiltinProviderId } from "./provider.js";
import { resolveKey } from "./auth.js";

export type FreeProviderEntry = {
  id: BuiltinProviderId;
  /** One short honest line — what you actually get, no marketing. */
  freeOffer: string;
  /** "no" = runs with no key at all; "free-key" = signup, no card. */
  keyNeeded: "no" | "free-key";
  /** Quota line as verified 2026-09-11; says "unpublished" when it is. */
  limits: string;
};

/** Chain entry joined with its builtin registry columns. */
export type FreeProviderRow = FreeProviderEntry & {
  brand: string;
  envVar: string;
  keyUrl: string;
};

/**
 * Ordered free chain for `codewhip run --free` — endpoint facts verified
 * 2026-09-11. List order is hop order: keyless tiers first (kilo's free
 * models are fully anonymous and tool-verified), then the free-key tiers,
 * the keyless safety net (llm7) LAST so a run still moves when every stored
 * key is gone. nvidia/mistral predate the chain but ride it too.
 */
export const FREE_CHAIN: readonly FreeProviderEntry[] = [
  { id: "kilo", freeOffer: "Kilo gateway ':free' models — anonymous, no key, no headers", keyNeeded: "no", limits: "free-model daily caps unpublished — wait and retry" },
  { id: "opencode", freeOffer: "OpenCode Zen free models — anonymous ('public' key + identity headers, handled by codewhip)", keyNeeded: "no", limits: "small per-IP anonymous quota (FreeUsageLimitError on 429); published quotas none" },
  { id: "empero", freeOffer: "Empero free endpoint (glm-5.3-flash) — no signup; prompts may be logged", keyNeeded: "no", limits: "unpublished; endpoint was in maintenance at the 2026-09-11 probe" },
  { id: "groq", freeOffer: "Groq free tier on open models", keyNeeded: "free-key", limits: "~30 req/min per model, ~14.4k req/day" },
  { id: "cerebras", freeOffer: "Cerebras free tier on fast inference", keyNeeded: "free-key", limits: "free-tier numbers unpublished — wait and retry" },
  { id: "openrouter", freeOffer: "OpenRouter :free models", keyNeeded: "free-key", limits: "50 req/day without credits; 1000/day after a $10 credit purchase" },
  { id: "gemini", freeOffer: "Gemini free tier (flash)", keyNeeded: "free-key", limits: "small in 2026 (tens of req/day) — wait and retry" },
  { id: "zai", freeOffer: "GLM flash free (limited-time promo)", keyNeeded: "free-key", limits: "free status is limited-time — expect quota errors when the promo ends" },
  { id: "nvidia", freeOffer: "NVIDIA-hosted open models", keyNeeded: "free-key", limits: "~40 req/min" },
  { id: "mistral", freeOffer: "Mistral free mode", keyNeeded: "free-key", limits: "caps RPS + tokens/min + tokens/month — see Limits in console.mistral.ai" },
  { id: "llm7", freeOffer: "anonymous gateway — works with no key at all", keyNeeded: "no", limits: "heavily rate-limited; a free dash.llm7.io token raises limits" },
];

/** Ordered chain ids (keyless tiers first; llm7 keyless floor last). */
export function freeChainIds(): BuiltinProviderId[] {
  return FREE_CHAIN.map((e) => e.id);
}

/** Chain entries joined with their PROVIDERS config rows. Pure, never throws. */
export function listFreeProviders(): FreeProviderRow[] {
  const rows: FreeProviderRow[] = [];
  for (const e of FREE_CHAIN) {
    const cfg = PROVIDERS[e.id];
    if (cfg === undefined) continue;
    rows.push({ ...e, brand: cfg.brand, envVar: cfg.envVar, keyUrl: cfg.keyUrl });
  }
  return rows;
}

/**
 * Chain ids the run can actually use: resolveKey must yield a non-empty
 * key (env, stored file, or the provider's anonymousKey). This is the
 * `--free` chain source — keyless rows always pass via anonymousKey.
 */
export function freeChainCandidates(): BuiltinProviderId[] {
  return freeChainIds().filter((id) => resolveKey(id).key.length > 0);
}
