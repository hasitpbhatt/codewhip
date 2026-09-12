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
 * 2026-09-11. List order is hop order: keyless tiers first (kilo/opencode/
 * empero/pollinations are fully anonymous and tool-verified), then the
 * free-key tiers (activated only when their key is present), the keyless
 * safety net (llm7) LAST so a run still moves when every stored key is gone.
 * nvidia/mistral predate the chain but ride it too. The 18 OpenAI-compatible
 * providers onboarded 2026-09-11 (sambanova … ppio) sit as free-key hops so
 * they auto-join the chain once a user adds a key via `codewhip auth`.
 */
export const FREE_CHAIN: readonly FreeProviderEntry[] = [
  { id: "kilo", freeOffer: "Kilo gateway ':free' models — anonymous, no key, no headers", keyNeeded: "no", limits: "free-model daily caps unpublished — wait and retry" },
  { id: "opencode", freeOffer: "OpenCode Zen free models — anonymous ('public' key + identity headers, handled by codewhip)", keyNeeded: "no", limits: "small per-IP anonymous quota (FreeUsageLimitError on 429); published quotas none" },
  { id: "empero", freeOffer: "Empero free endpoint (glm-5.3-flash) — no signup; prompts may be logged", keyNeeded: "no", limits: "unpublished; endpoint was in maintenance at the 2026-09-11 probe" },
  { id: "pollinations", freeOffer: "Pollinations.ai — anonymous, no key, no signup (OpenAI-compatible text+image)", keyNeeded: "no", limits: "per-IP rate-limited (~1 req/s) — back off and retry" },
  { id: "groq", freeOffer: "Groq free tier on open models", keyNeeded: "free-key", limits: "~30 req/min per model, ~14.4k req/day" },
  { id: "cerebras", freeOffer: "Cerebras free tier on fast inference", keyNeeded: "free-key", limits: "free-tier numbers unpublished — wait and retry" },
  { id: "openrouter", freeOffer: "OpenRouter :free models", keyNeeded: "free-key", limits: "50 req/day without credits; 1000/day after a $10 credit purchase" },
  { id: "gemini", freeOffer: "Gemini free tier (flash)", keyNeeded: "free-key", limits: "small in 2026 (tens of req/day) — wait and retry" },
  { id: "zai", freeOffer: "GLM flash free (limited-time promo)", keyNeeded: "free-key", limits: "free status is limited-time — expect quota errors when the promo ends" },
  { id: "nvidia", freeOffer: "NVIDIA-hosted open models", keyNeeded: "free-key", limits: "~40 req/min" },
  { id: "mistral", freeOffer: "Mistral free mode", keyNeeded: "free-key", limits: "caps RPS + tokens/min + tokens/month — see Limits in console.mistral.ai" },
  { id: "sambanova", freeOffer: "SambaNova Cloud free tier (fast RDU inference)", keyNeeded: "free-key", limits: "~200k tokens/day" },
  { id: "chutes", freeOffer: "Chutes free API (decentralized Bittensor open models)", keyNeeded: "free-key", limits: "rate-limited free tier" },
  { id: "hyperbolic", freeOffer: "Hyperbolic free daily credits", keyNeeded: "free-key", limits: "free daily allowance on open models" },
  { id: "lepton", freeOffer: "Lepton AI free hosted open models", keyNeeded: "free-key", limits: "free quota" },
  { id: "xai", freeOffer: "xAI Grok promo free credits", keyNeeded: "free-key", limits: "promo credits via data-sharing program" },
  { id: "huggingface", freeOffer: "Hugging Face serverless inference free quota", keyNeeded: "free-key", limits: "serverless free quota" },
  { id: "upstage", freeOffer: "Upstage Solar free tier", keyNeeded: "free-key", limits: "free tier" },
  { id: "novita", freeOffer: "Novita AI free trial credits", keyNeeded: "free-key", limits: "trial credits (~$0.5–$1)" },
  { id: "parasail", freeOffer: "Parasail free tier", keyNeeded: "free-key", limits: "free tier" },
  { id: "volcengine", freeOffer: "Volcengine Ark Doubao free quota", keyNeeded: "free-key", limits: "Doubao free quota" },
  { id: "qianfan", freeOffer: "Baidu Qianfan ERNIE free trial tokens", keyNeeded: "free-key", limits: "ERNIE free trial tokens" },
  { id: "hunyuan", freeOffer: "Tencent Hunyuan free quota", keyNeeded: "free-key", limits: "Hunyuan free quota" },
  { id: "moonshot", freeOffer: "Moonshot Kimi free API quota", keyNeeded: "free-key", limits: "Kimi free quota" },
  { id: "deepseek", freeOffer: "DeepSeek free API credits (new users)", keyNeeded: "free-key", limits: "free credits for new users" },
  { id: "minimax", freeOffer: "MiniMax free API quota", keyNeeded: "free-key", limits: "free API quota" },
  { id: "stepfun", freeOffer: "StepFun free API quota", keyNeeded: "free-key", limits: "free quota" },
  { id: "ppio", freeOffer: "PPIO free trial credits", keyNeeded: "free-key", limits: "trial credits" },
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
