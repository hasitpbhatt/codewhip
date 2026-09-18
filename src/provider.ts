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

/** Builtins shipped with the install (llm7/tokenharbor/bai/fabryka: gateway tiers; the rest: free aggregators). */
export type BuiltinProviderId = "nvidia" | "mistral" | "sensenova" | "alibaba" | "llm7" | "tokenharbor" | "bai" | "fabryka" | "opencode" | "kilo" | "groq" | "cerebras" | "openrouter" | "gemini" | "zai" | "empero" | "pollinations" | "sambanova" | "chutes" | "hyperbolic" | "xai" | "huggingface" | "upstage" | "novita" | "parasail" | "volcengine" | "qianfan" | "hunyuan" | "moonshot" | "deepseek" | "minimax" | "stepfun" | "ppio" | "cloudflare" | "modelscope" | "ovhcloud" | "ollama" | "cohere" | "siliconflow" | "aionlabs" | "agnes" | "requesty" | "inference" | "hetzner" | "venice" | "scaleway" | "friendli" | "nscale" | "nebius" | "ai21" | "coze" | "1min" | "hcnsec" | "hashneuron" | "anyrouter" | "apinex" | "zukijourney" | "nagaai" | "zanityai" | "kimetsu" | "navyapi" | "mnn" | "hcap" | "voltai" | "electronhub" | "xkiro" | "gonkarouter" | "bazaarlink" | "seldon" | "cavoti" | "getunikey" | "freetheai" | "gmicloud" | "inferx" | "kkiai" | "seekai" | "bynara" | "atria" | "onerouter" | "xpiki";

/** Any provider id: a builtin or a user-registered custom id. */
export type ProviderId = string;

export const PROVIDER_IDS: readonly BuiltinProviderId[] = [
  "nvidia",
  "mistral",
  "sensenova",
  "alibaba",
  "llm7",
  "tokenharbor",
  "bai",
  "fabryka",
  "opencode",
  "kilo",
  "groq",
  "cerebras",
  "openrouter",
  "gemini",
  "zai",
  "empero",
  "pollinations",
  "sambanova",
  "chutes",
  "hyperbolic",
  "xai",
  "huggingface",
  "upstage",
  "novita",
  "parasail",
  "volcengine",
  "qianfan",
  "hunyuan",
  "moonshot",
  "deepseek",
  "minimax",
  "stepfun",
  "ppio",
  // Free-tier candidates harvested 2026-09-13 (freellm.net + peer directories,
  // each cross-checked against a second source). All are free-key hops: none
  // carries an anonymousKey, so none joins the chain without a stored key.
  "cloudflare",
  "modelscope",
  "ovhcloud",
  "ollama",
  "cohere",
  "siliconflow",
  "aionlabs",
  "agnes",
  "requesty",
  "inference",
  "hetzner",
  "venice",
  "scaleway",
  "friendli",
  "nscale",
  "nebius",
  "ai21",
  "coze",
  // Keyed New API gateway (user-specified 2026-09-14) — NOT in FREE_CHAIN.
  "hcnsec",
  // Not OpenAI-shaped — rides its own port (see `PortKind` below and
  // src/onemin.ts). Credit-based, so it is deliberately NOT in FREE_CHAIN.
  "1min",
  // Keyed OpenAI-compatible gateway (user-specified 2026-09-14) — NOT in
  // FREE_CHAIN: beyond its daily free grant it draws on a prepaid balance.
  "hashneuron",
  // 2026-09-16: new providers onboarded.
  "anyrouter", // free-key gateway, 184+ models, OpenAI-compatible.
  "apinex", // paid aggregator, $0.07/1M tokens.
  "zukijourney", // community gateway, free tier.
  "nagaai", // community gateway, free tier.
  "zanityai", // community gateway, free tier.
  "kimetsu", // community gateway, free tier.
  "navyapi", // community gateway, free tier.
  "mnn", // community gateway, free tier.
  "hcap", // community gateway, free tier.
  "voltai", // community gateway, free tier.
  "electronhub", // community gateway, free tier.
  // User-sourced gateways (2026-09-16).
  "freetheai", // OpenAI-compatible.
  "gmicloud", // OpenAI-compatible.
  "inferx", // OpenAI-compatible.
  "kkiai", // OpenAI-compatible.
  "seekai", // OpenAI-compatible.
  "xkiro", // OpenAI-compatible, /v1/models works without key.
  "gonkarouter", // OpenAI-compatible router.
  "bazaarlink", // OpenAI SDK drop-in.
  "seldon", // OpenAI-compatible.
  "cavoti", // OpenAI-compatible.
  "getunikey", // OpenAI-compatible.
  "bynara", // OpenAI-compatible router.
  "atria", // OpenAI-compatible.
  "onerouter", // OpenAI-compatible router.
  "xpiki", // OpenAI-compatible.
];

export function isBuiltinProviderId(value: string): value is BuiltinProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Which wire adapter serves a row. `"openai"` (the default) is the
 * OpenAI-compatible ChatPort every builtin and custom provider rides.
 * `"onemin"` is the exception: 1min.ai is not OpenAI-shaped at all — no
 * `messages[]`, no `tools`, no `usage` — so it needs a real translating
 * adapter rather than a base-URL row. See src/onemin.ts.
 */
export type PortKind = "openai" | "onemin";

export type ProviderConfig = {
  id: string;
  /** Display/error prefix. */
  brand: string;
  /** Origin only — chatPath/modelsPath are appended (fixes mixed /v1 layouts). */
  baseUrl: string;
  /** Chat-completions path appended to baseUrl. */
  chatPath: string;
  /** Model-listing path appended to baseUrl (`codewhip models`). */
  modelsPath: string;
  defaultModel: string;
  envVar: string;
  keyUrl: string;
  timeoutMs: number;
  /** Optional 429-specific hint (provider quota nuance). */
  rateLimitedHint?: string;
  /**
   * Fallback key when no env/file key exists (llm7's anonymous "unused").
   * Runs still work keyless; `auth login` upgrades to higher limits.
   */
  anonymousKey?: string;
  /**
   * Per-provider static headers merged into every chat/models call
   * (opencode zen's free tier is identity-header gated: requests without
   * x-opencode-session are refused with MissingSessionID — verified
   * 2026-09-11 with a presence-only check, dummy value passes).
   */
  headers?: Record<string, string>;
  /**
   * Extra base URLs to try (in order) when `baseUrl` auths with 401/403.
   * StepFun is the motivating case: keys are bound to api.stepfun.ai while
   * api.stepfun.com rejects them, so listing both lets codewhip auto-detect
   * and then "stick" to whichever host a provider's key actually works on.
   * The first host that authenticates is pinned in `provider-hosts.json`.
   */
  fallbackBaseUrls?: string[];
  /**
   * Wire adapter for this row. Omitted means "openai" (the OpenAI-compatible
   * path every builtin/custom provider uses). Only set this when a provider
   * needs its own translation layer.
   */
  port?: PortKind;
};

/**
 * Single default for every builtin chat call. One place on purpose: eight
 * identical per-provider constants already diverged once (45s -> 120s), and
 * per-provider tuning belongs in the row below, not in a constant farm.
 * Custom providers carry their own timeoutMs (default in custom-providers.ts).
 */
export const DEFAULT_CHAT_TIMEOUT_MS = 120000;
/**
 * Bounds for any per-call chat budget. The ceiling deliberately exceeds the
 * default: free endpoints routinely need 60–100s per call, so a cap equal to
 * the default (the old 120000) left no way to buy headroom on a slow model
 * without re-registering the provider as a custom one.
 */
export const MIN_CHAT_TIMEOUT_MS = 5000;
export const MAX_CHAT_TIMEOUT_MS = 600000;
const MAX_BODY_CHARS = 500;

export const PROVIDERS: Record<BuiltinProviderId, ProviderConfig> = {
  nvidia: {
    id: "nvidia",
    brand: "nvidia",
    baseUrl: "https://integrate.api.nvidia.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "moonshotai/kimi-k3",
    envVar: "NVIDIA_API_KEY",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier ~40 req/min — wait and retry",
  },
  mistral: {
    id: "mistral",
    brand: "mistral",
    baseUrl: "https://api.mistral.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mistral-small-latest",
    envVar: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint:
      "free mode caps RPS + tokens/min + tokens/month — see Limits in console.mistral.ai",
  },
  sensenova: {
    id: "sensenova",
    brand: "sensenova",
    baseUrl: "https://token.sensenova.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "sensenova-6.8-flash-lite",
    envVar: "SENSENOVA_API_KEY",
    keyUrl: "https://token.sensenova.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  },
  alibaba: {
    id: "alibaba",
    brand: "alibaba",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "qwen-plus",
    envVar: "ALIBABA_API_KEY",
    keyUrl: "https://dashscope-intl.aliyun.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  },
  llm7: {
    id: "llm7",
    brand: "llm7",
    baseUrl: "https://api.llm7.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "default",
    envVar: "LLM7_API_KEY",
    keyUrl: "https://dash.llm7.io",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "anonymous access is heavily rate-limited — add a dash.llm7.io token for higher limits",
    anonymousKey: "unused",
  },
  tokenharbor: {
    id: "tokenharbor",
    brand: "tokenharbor",
    baseUrl: "https://tokenharbor.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "th-orchestra",
    envVar: "TOKENHARBOR_API_KEY",
    keyUrl: "https://tokenharbor.ai/dashboard/api-keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  },
  bai: {
    id: "bai",
    brand: "bai",
    baseUrl: "https://api.b.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    // Pricing-table pick (cheapest stable input); exact API slugs sit
    // behind login — tagged untested until a live probe clears it.
    defaultModel: "GPT-5 Nano",
    envVar: "BAI_API_KEY",
    keyUrl: "https://chat.b.ai/chat",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
  },
  fabryka: {
    id: "fabryka",
    brand: "fabryka",
    baseUrl: "https://router.fabryka.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "qwen3.6-35b-a3b",
    envVar: "FABRYKA_API_KEY",
    keyUrl: "https://router.fabryka.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "single-GPU backend: keep concurrency at 1, concurrent requests fail",
  },
  // Free aggregators (endpoint facts live-verified 2026-09-11). Free-chain
  // ordering + honest quota lines live in free-providers.ts.
  opencode: {
    id: "opencode",
    brand: "opencode",
    baseUrl: "https://opencode.ai",
    chatPath: "/zen/v1/chat/completions",
    modelsPath: "/zen/v1/models",
    // defaultModel: deepseek-v4-flash-free was the catalog pick but its
    // upstream 400'd "Model is unavailable" on both 2026-09-11 probes;
    // mimo-v2.5-free answered keyless end-to-end via codewhip the same day.
    defaultModel: "mimo-v2.5-free",
    envVar: "OPENCODE_API_KEY",
    keyUrl: "https://opencode.ai/zen",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free-model quotas unpublished — wait and retry",
    // Free-tier mechanism verified 2026-09-11: with no key the Zen client
    // sends literally "public" as the bearer plus its identity headers; the
    // server presence-checks the session header (dummy value passes) and
    // enforces a small per-IP anonymous quota (FreeUsageLimitError on 429).
    anonymousKey: "public",
    headers: {
      "x-opencode-session": "ses-codewhip-free",
      "User-Agent": "opencode/1.0.0",
    },
  },
  kilo: {
    id: "kilo",
    brand: "kilo",
    baseUrl: "https://api.kilo.ai",
    chatPath: "/api/gateway/v1/chat/completions",
    modelsPath: "/api/gateway/v1/models",
    defaultModel: "cohere/north-mini-code:free",
    envVar: "KILO_API_KEY",
    keyUrl: "https://kilo.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free-model daily caps unpublished — wait and retry",
    // ':free' models are fully anonymous (verified 2026-09-11: chat works
    // with no Authorization header at all; paid models 401 without a key).
    // The placeholder only clears the port's empty-key guard.
    anonymousKey: "anonymous",
  },
  groq: {
    id: "groq",
    brand: "groq",
    baseUrl: "https://api.groq.com",
    chatPath: "/openai/v1/chat/completions",
    modelsPath: "/openai/v1/models",
    defaultModel: "openai/gpt-oss-120b",
    envVar: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier ~30 req/min per model, ~14.4k req/day",
  },
  cerebras: {
    id: "cerebras",
    brand: "cerebras",
    baseUrl: "https://api.cerebras.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "qwen-3-coder-480b",
    envVar: "CEREBRAS_API_KEY",
    keyUrl: "https://cloud.cerebras.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    // Was a no-card free tier; Cerebras announced a move to a points/credit
    // model (Aug 2026) — the grant requires a verified payment method and
    // expires after 30 days, then bills pay-go. Deliberately NOT in FREE_CHAIN
    // (see free-providers.ts): a --free run must never bill. Re-probe before
    // restoring it there.
    rateLimitedHint: "no forever-free tier: $5 credits need a verified card and expire in 30 days, then pay-go billing",
  },
  openrouter: {
    id: "openrouter",
    brand: "openrouter",
    baseUrl: "https://openrouter.ai",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b:free",
    envVar: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free models: 50 req/day without credits, 1000/day after a $10 credit purchase",
  },
  gemini: {
    id: "gemini",
    brand: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    chatPath: "/v1beta/openai/chat/completions",
    modelsPath: "/v1beta/openai/models",
    defaultModel: "gemini-2.5-flash",
    envVar: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier is small in 2026 (tens of req/day) — wait and retry",
  },
  zai: {
    id: "zai",
    brand: "zai",
    baseUrl: "https://api.z.ai",
    chatPath: "/api/paas/v4/chat/completions",
    modelsPath: "/api/paas/v4/models",
    defaultModel: "glm-5.3-flash",
    envVar: "ZAI_API_KEY",
    keyUrl: "https://z.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "GLM flash free status is limited-time — expect quota errors when the promo ends",
  },
  empero: {
    id: "empero",
    brand: "empero",
    baseUrl: "https://free.empero.org",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "glm-5.3-flash",
    envVar: "EMPERO_API_KEY",
    keyUrl: "https://free.empero.org",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free endpoint, limits unpublished — wait and retry (prompts may be logged: never send private code)",
    // Openly free: no signup, "free" is the documented placeholder key for
    // clients that require one. Still in a DECLARED maintenance window when
    // re-probed 2026-09-14 (consistent 503, code "maintenance") — it is not
    // dead the way lepton was, so it stays in FREE_CHAIN; a failing hop just
    // rotates. Its notice says the served models are changing, so `defaultModel`
    // and the `empero:glm-5.3-flash` $0 entry in router.ts both need
    // re-verifying when it returns.
    anonymousKey: "free",
  },
  // === Onboarded free OpenAI-compatible providers (2026-09-11 addendum) ===
  // Best-known OpenAI-compatible bases; default models are unverified slugs —
  // confirm via `codewhip models <id>` before relying on them.
  pollinations: {
    id: "pollinations",
    brand: "pollinations",
    baseUrl: "https://text.pollinations.ai",
    chatPath: "/openai/chat/completions",
    modelsPath: "/openai/models",
    // Live-probed 2026-09-16: /openai/models lists only "openai-fast"; the
    // legacy "mistral" id now 404s ("visit enter.pollinations.ai").
    defaultModel: "openai-fast",
    envVar: "POLLINATIONS_API_KEY",
    keyUrl: "https://pollinations.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyless but per-IP rate-limited (~1 req/s) — back off and retry",
    anonymousKey: "unused",
  },
  sambanova: {
    id: "sambanova",
    brand: "sambanova",
    baseUrl: "https://api.sambanova.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Meta-Llama-3.3-70B-Instruct",
    envVar: "SAMBANOVA_API_KEY",
    keyUrl: "https://cloud.sambanova.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier ~200k tokens/day",
  },
  chutes: {
    id: "chutes",
    brand: "chutes",
    // Chutes' own pricing page documents llm.chutes.ai as the inference host
    // and lists no free tier (pay per 1M tokens, no subscription). The older
    // api.chutes.ai host stays as a fallback so a stored key issued against it
    // still resolves.
    baseUrl: "https://llm.chutes.ai",
    fallbackBaseUrls: ["https://api.chutes.ai"],
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    envVar: "CHUTES_API_KEY",
    keyUrl: "https://chutes.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    // The sponsored free tier (~20B tokens/day via OpenRouter) was retired in
    // 2026-03; pricing is now per-token. Removed from FREE_CHAIN accordingly.
    rateLimitedHint: "pay-per-token, no free tier since 2026-03 — this provider bills",
  },
  hyperbolic: {
    id: "hyperbolic",
    brand: "hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "HYPERBOLIC_API_KEY",
    keyUrl: "https://hyperbolic.xyz",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free daily credits",
  },
  xai: {
    id: "xai",
    brand: "xai",
    baseUrl: "https://api.x.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "grok-2-latest",
    envVar: "XAI_API_KEY",
    keyUrl: "https://x.ai/api",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "promo free credits (data-sharing program)",
  },
  huggingface: {
    id: "huggingface",
    brand: "huggingface",
    baseUrl: "https://api-inference.huggingface.co",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "HUGGINGFACE_API_KEY",
    keyUrl: "https://huggingface.co/settings/tokens",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "serverless inference free quota",
  },
  upstage: {
    id: "upstage",
    brand: "upstage",
    baseUrl: "https://api.upstage.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "solar-pro2-preview",
    envVar: "UPSTAGE_API_KEY",
    keyUrl: "https://upstage.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier",
  },
  novita: {
    id: "novita",
    brand: "novita",
    baseUrl: "https://api.novita.ai",
    chatPath: "/v3/openai/chat/completions",
    modelsPath: "/v3/openai/models",
    defaultModel: "meta-llama/llama-3.3-70b-instruct",
    envVar: "NOVITA_API_KEY",
    keyUrl: "https://novita.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free trial credits (~$0.5–$1)",
  },
  parasail: {
    id: "parasail",
    brand: "parasail",
    baseUrl: "https://api.parasail.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-oss-120b",
    envVar: "PARASAIL_API_KEY",
    keyUrl: "https://parasail.io",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier",
  },
  volcengine: {
    id: "volcengine",
    brand: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com",
    chatPath: "/api/v3/chat/completions",
    modelsPath: "/api/v3/models",
    defaultModel: "doubao-seed-1.6-250615",
    envVar: "VOLCENGINE_API_KEY",
    keyUrl: "https://console.volcengine.com/ark",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Doubao free quota (Ark)",
  },
  qianfan: {
    id: "qianfan",
    brand: "qianfan",
    baseUrl: "https://qianfan.baidubce.com",
    chatPath: "/v2/chat/completions",
    modelsPath: "/v2/models",
    defaultModel: "ernie-4.5-8k",
    envVar: "QIANFAN_API_KEY",
    keyUrl: "https://cloud.baidu.com/product/wenxinworkshop",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "ERNIE free trial tokens",
  },
  hunyuan: {
    id: "hunyuan",
    brand: "hunyuan",
    baseUrl: "https://api.hunyuan.cloud.tencent.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "hunyuan-turbos-latest",
    envVar: "HUNYUAN_API_KEY",
    keyUrl: "https://cloud.tencent.com/product/hunyuan",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Hunyuan free quota",
  },
  moonshot: {
    id: "moonshot",
    brand: "moonshot",
    baseUrl: "https://api.moonshot.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "moonshot-v1-8k",
    envVar: "MOONSHOT_API_KEY",
    keyUrl: "https://platform.moonshot.cn",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Kimi free API quota",
  },
  deepseek: {
    id: "deepseek",
    brand: "deepseek",
    baseUrl: "https://api.deepseek.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-chat",
    envVar: "DEEPSEEK_API_KEY",
    keyUrl: "https://platform.deepseek.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free API credits for new users",
  },
  minimax: {
    id: "minimax",
    brand: "minimax",
    baseUrl: "https://api.minimax.chat",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "MiniMax-Text-01",
    envVar: "MINIMAX_API_KEY",
    keyUrl: "https://minimax.io/platform",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free API quota",
  },
  stepfun: {
    id: "stepfun",
    brand: "stepfun",
    // StepFun serves the API on both api.stepfun.com and api.stepfun.ai, but a
    // given key is bound to ONE backend: keys issued against .ai 401 on .com.
    // List both so codewhip auto-detects and "sticks" to whichever host the
    // stored key actually authenticates on (verified 2026-09-11 with a live key).
    baseUrl: "https://api.stepfun.com",
    fallbackBaseUrls: ["https://api.stepfun.ai"],
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    // Verified against StepFun OpenAI-migration docs (2026-09): current catalog
    // is step-3.7-flash / step-3.5-flash. step-3.5-flash is the language
    // reasoning model (code/software-engineering fit); step-2-mini is retired.
    defaultModel: "step-3.5-flash",
    envVar: "STEPFUN_API_KEY",
    keyUrl: "https://platform.stepfun.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free API quota",
  },
  ppio: {
    id: "ppio",
    brand: "ppio",
    baseUrl: "https://api.ppio.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/llama-3.3-70b-instruct",
    envVar: "PIO_API_KEY",
    keyUrl: "https://ppio.cn",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free trial credits",
  },
  // === Free-tier candidates harvested 2026-09-13 ===
  // Sources: freellm.net/providers, awesome-freellm-apis, nejib1/Free-LLM,
  // freellmpool, free-llm.com — every row confirmed on >=2 independent lists,
  // with base URLs additionally checked against the @yola/client and aichat
  // provider registries. Default models are best-known slugs, NOT live-probed:
  // confirm with `codewhip models <id>` before relying on one.
  cloudflare: {
    id: "cloudflare",
    brand: "cloudflare",
    // Account-scoped: Workers AI serves the OpenAI-compatible surface under
    // /accounts/<id>/ai, so the row carries a {PLACEHOLDER} resolved from the
    // environment at call time (see resolveBaseUrl). Cloudflare's console calls
    // the credential an "API token"; the env var follows this repo's *_API_KEY
    // convention so `auth` and the test suite stay uniform.
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    envVar: "CLOUDFLARE_API_KEY",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free allowance is 10k neurons/day, shared across all models",
  },
  modelscope: {
    id: "modelscope",
    brand: "modelscope",
    baseUrl: "https://api-inference.modelscope.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Qwen/Qwen3-32B",
    envVar: "MODELSCOPE_API_KEY",
    keyUrl: "https://modelscope.cn/my/myaccesstoken",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "2,000 requests/day total, <=500/day per model — requires real-name verification",
  },
  ovhcloud: {
    id: "ovhcloud",
    brand: "ovhcloud",
    // OVH also serves an anonymous tier at 2 req/min; too slow to be a useful
    // chain hop, so this row is keyed (400 req/min authenticated).
    baseUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Meta-Llama-3_3-70B-Instruct",
    envVar: "OVHCLOUD_API_KEY",
    keyUrl: "https://endpoints.ai.cloud.ovh.net",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier: 2 req/min anonymous, 400 req/min authenticated — service is in beta",
  },
  ollama: {
    id: "ollama",
    brand: "ollama-cloud",
    baseUrl: "https://ollama.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-oss:120b",
    envVar: "OLLAMA_API_KEY",
    keyUrl: "https://ollama.com/settings/keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "light usage tier: 1 concurrent model, session + weekly caps reset on a rolling window",
  },
  cohere: {
    id: "cohere",
    brand: "cohere",
    // Cohere's OpenAI compatibility layer lives under /compatibility/v1 — the
    // native /v2 surface is a different request shape and is not used here.
    baseUrl: "https://api.cohere.com",
    chatPath: "/compatibility/v1/chat/completions",
    modelsPath: "/compatibility/v1/models",
    defaultModel: "command-a-03-2025",
    envVar: "COHERE_API_KEY",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial key: 20 req/min and ~1,000 req/month shared across models",
  },
  siliconflow: {
    id: "siliconflow",
    brand: "siliconflow",
    baseUrl: "https://api.siliconflow.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Qwen/Qwen3-8B",
    envVar: "SILICONFLOW_API_KEY",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free models: 30 req/min, 60k tokens/min — identity verification required. Global keys use api.siliconflow.com",
  },
  aionlabs: {
    id: "aionlabs",
    brand: "aionlabs",
    baseUrl: "https://api.aionlabs.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "aion-labs/aion-1.0-mini",
    envVar: "AIONLABS_API_KEY",
    keyUrl: "https://aionlabs.ai/app/api-keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier ~15 req/min and ~20k tokens/day; no card required",
  },
  agnes: {
    id: "agnes",
    brand: "agnes",
    baseUrl: "https://apihub.agnes-ai.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "agnes-2.0-flash",
    envVar: "AGNES_API_KEY",
    keyUrl: "https://platform.agnes-ai.com/settings/apiKeys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier ~30 req/min",
  },
  requesty: {
    id: "requesty",
    brand: "requesty",
    baseUrl: "https://router.requesty.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    // Router: model ids are namespaced "<vendor>/<model>".
    defaultModel: "openai/gpt-4o-mini",
    envVar: "REQUESTY_API_KEY",
    keyUrl: "https://app.requesty.ai/api-keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free models: 60 req/min, 200 req/day",
  },
  inference: {
    id: "inference",
    brand: "inference.net",
    baseUrl: "https://api.inference.net",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/llama-3.1-70b-instruct",
    envVar: "INFERENCE_API_KEY",
    keyUrl: "https://inference.net",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier ~30 req/min under a fair-use policy",
  },
  hetzner: {
    id: "hetzner",
    brand: "hetzner",
    // Experimental product: no SLA, and Hetzner has said billing may be
    // introduced once it leaves the experimental phase.
    baseUrl: "https://inference.hetzner.com",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "Qwen/Qwen3.6-35B-A3B",
    envVar: "HETZNER_API_KEY",
    keyUrl: "https://experiments.hetzner.com/inference",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "experimental + EU-hosted, no SLA: 3M in / 60k out tokens per 60s",
  },
  venice: {
    id: "venice",
    brand: "venice",
    baseUrl: "https://api.venice.ai",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "llama-3.3-70b",
    envVar: "VENICE_API_KEY",
    keyUrl: "https://venice.ai/settings/api",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier 10 req/min; provider advertises no prompt logging",
  },
  scaleway: {
    id: "scaleway",
    brand: "scaleway",
    baseUrl: "https://api.scaleway.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "llama-3.3-70b-instruct",
    envVar: "SCALEWAY_API_KEY",
    keyUrl: "https://console.scaleway.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "1M free tokens (one-time, per model) — EU/GDPR-hosted",
  },
  friendli: {
    id: "friendli",
    brand: "friendli",
    baseUrl: "https://inference.friendli.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "FRIENDLI_API_KEY",
    keyUrl: "https://suite.friendli.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "$10 one-time trial credits; ~60 req/min",
  },
  nscale: {
    id: "nscale",
    brand: "nscale",
    baseUrl: "https://inference.api.nscale.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "NSCALE_API_KEY",
    keyUrl: "https://console.nscale.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "$5 one-time signup credit (no card), then fair-use metering",
  },
  nebius: {
    id: "nebius",
    brand: "nebius",
    // Token Factory is the OpenAI-compatible surface; the older
    // api.studio.nebius.com host serves the same models under the same key.
    baseUrl: "https://api.tokenfactory.nebius.com",
    fallbackBaseUrls: ["https://api.studio.nebius.com"],
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "NEBIUS_API_KEY",
    keyUrl: "https://studio.nebius.com/settings/api-keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "~60 req/min; the free grant is $1 and requires a card on file",
  },
  ai21: {
    id: "ai21",
    brand: "ai21",
    baseUrl: "https://api.ai21.com",
    chatPath: "/studio/v1/chat/completions",
    modelsPath: "/studio/v1/models",
    defaultModel: "jamba-large-1.7",
    envVar: "AI21_API_KEY",
    keyUrl: "https://studio.ai21.com/account/api-key",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "$10 trial credits expiring after 3 months; 200 req/min, 10 req/s",
  },
  coze: {
    id: "coze",
    brand: "coze",
    // ByteDance's Coze is bot-oriented: the OpenAI-compatible route proxies a
    // hosted bot, so model ids are coarse and quota is token-based per day.
    baseUrl: "https://api.coze.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o",
    envVar: "COZE_API_KEY",
    keyUrl: "https://www.coze.com/open/oauth/pats",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier is token-metered with daily resets — limits vary per proxied model",
  },
  "1min": {
    id: "1min",
    brand: "1min.ai",
    // Deliberately not OpenAI-shaped, so it rides `port: "onemin"` and the
    // adapter in src/onemin.ts does the translating: POST /api/chat-with-ai
    // with a `type: UNIFY_CHAT_WITH_AI` discriminator, ONE flattened
    // `promptObject.prompt` string instead of a messages[] array, no `tools`
    // field, and no `usage` block in the response. chatPath/modelsPath are
    // the real 1min paths (kept for display/errors), not OpenAI ones.
    baseUrl: "https://api.1min.ai",
    chatPath: "/api/chat-with-ai",
    modelsPath: "/models",
    defaultModel: "gpt-4o-mini",
    // Cannot be `1MIN_API_KEY`: POSIX shells reject an identifier starting
    // with a digit, so `1MIN_API_KEY=x cmd` never reaches the process.
    envVar: "ONEMIN_API_KEY",
    keyUrl: "https://docs.1min.ai/docs/api/create-api-key",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    port: "onemin",
    rateLimitedHint: "credit-metered — every call spends credits from your plan, not a free tier",
  },
  // Added 2026-09-14, user-specified endpoint, live-probed: both /v1/models
  // and /v1/chat/completions answer 401 {"error":{"type":"new_api_error"}}
  // without a token, confirming an open-source New API gateway sitting on
  // standard OpenAI paths.
  //
  // defaultModel is `auto` rather than a concrete id on purpose: hcnsec is a
  // relay whose served set is unstable (its own docs report individual models
  // down at times) and whose docs insist a model id must match the console's
  // Model Plaza *exactly*. `auto` is the documented smart-routing entry, so it
  // is the one id that stays valid as the catalog shifts; a guessed concrete
  // id 404s on the first call. Confirm the live set with `codewhip models
  // hcnsec` once a key is stored.
  //
  // Keyed, and its free allowance is an unpublished console quota rather than
  // a fixed grant — so like 1min it is NOT in FREE_CHAIN. `--free` must never
  // bill pay-go. Reach it with `--provider hcnsec`.
  hcnsec: {
    id: "hcnsec",
    brand: "hcnsec",
    baseUrl: "https://api.hcnsec.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "auto",
    envVar: "HCNSEC_API_KEY",
    keyUrl: "https://api.hcnsec.cn/console",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "New API relay — key required; the free allowance is a console-published quota, so confirm it with codewhip models hcnsec",
  },
  // Added 2026-09-14, user-specified endpoint, live-probed: both /v1/models and
  // /v1/chat/completions answer 401 {"error":{"type":"invalid_request_error",
  // "code":"invalid_api_key"}} without a token, i.e. a plain OpenAI-compatible
  // gateway — standard Bearer auth and a standard error envelope, so it rides
  // the generic `openAiPort` and needs no adapter. (Contrast hcnsec, whose 401
  // says `new_api_error`.)
  //
  // defaultModel is the literal id `default`, not a concrete model name. The
  // console's own model picker maps that id to the label "Auto"
  // (`id === "default" ? "Auto" : id` in its app.js), so `default` is the
  // gateway's server-side routing entry and the one id that stays valid as the
  // served catalog shifts. A guessed concrete id 404s on the first call — the
  // same trap hcnsec's `auto` avoids. Confirm the live set with `codewhip
  // models hashneuron` once a key is stored.
  //
  // Keyed, and NOT in FREE_CHAIN. Its landing page advertises "500,000 tokens
  // per day, reset at UTC midnight" for every account, but the same console
  // sells prepaid token packages and keeps a balance/ledger — so a call beyond
  // the daily grant draws on a paid balance rather than cleanly rate-limiting.
  // `--free` promises it never bills pay-go, so that is disqualifying until a
  // re-audit confirms the free grant is card-free *and* 429s on exhaustion.
  // Reach it with `--provider hashneuron`.
  hashneuron: {
    id: "hashneuron",
    brand: "RouteOpen",
    baseUrl: "https://hashneuron.space",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "default",
    envVar: "HASHNEURON_API_KEY",
    keyUrl: "https://hashneuron.space/#keys",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "RouteOpen gateway — key required; 500k tokens/day free per account, then it draws on your prepaid balance",
  },
  anyrouter: {
    id: "anyrouter",
    brand: "AnyRouter",
    baseUrl: "https://anyrouter.dev",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "anyrouter/free",
    envVar: "ANYROUTER_API_KEY",
    keyUrl: "https://anyrouter.dev/dashboard",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier: anyrouter/free models at $0/token, 1000 req/day; BYOK $0 markup",
  },
  apinex: {
    id: "apinex",
    brand: "APInex",
    baseUrl: "https://api.apinex.bond",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt/5.6-luna",
    envVar: "APINEX_API_KEY",
    keyUrl: "https://apinex.bond/dashboard",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "paid aggregator: from $0.07/1M tokens, no free tier",
  },
  zukijourney: {
    id: "zukijourney",
    brand: "zukijourney",
    baseUrl: "https://api.zukijourney.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "ZUKIJOURNEY_API_KEY",
    keyUrl: "https://api.zukijourney.com",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  nagaai: {
    id: "nagaai",
    brand: "NagaAI",
    baseUrl: "https://api.naga.ac",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "claude-3.5-sonnet",
    envVar: "NAGAAI_API_KEY",
    keyUrl: "https://api.naga.ac",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  zanityai: {
    id: "zanityai",
    brand: "ZanityAI",
    baseUrl: "https://api.zanity.xyz",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4.1",
    envVar: "ZANITYAI_API_KEY",
    keyUrl: "https://api.zanity.xyz",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  kimetsu: {
    id: "kimetsu",
    brand: "Kimetsu",
    baseUrl: "https://api.kimetsu.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "claude-3.5-sonnet",
    envVar: "KIMETSU_API_KEY",
    keyUrl: "https://api.kimetsu.ai",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  navyapi: {
    id: "navyapi",
    brand: "NavyAPI",
    baseUrl: "https://api.navy",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4.1",
    envVar: "NAVYAPI_API_KEY",
    keyUrl: "https://api.navy",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  mnn: {
    id: "mnn",
    brand: "MNN",
    baseUrl: "https://api.mnnai.ru",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4.1",
    envVar: "MNN_API_KEY",
    keyUrl: "https://api.mnnai.ru",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  hcap: {
    id: "hcap",
    brand: "hcap.ai",
    baseUrl: "https://hcap.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4.1",
    envVar: "HCAPI_API_KEY",
    keyUrl: "https://hcap.ai",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  voltai: {
    id: "voltai",
    brand: "VoltAI",
    baseUrl: "https://voltapi.online",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-r1",
    envVar: "VOLTAI_API_KEY",
    keyUrl: "https://voltapi.online",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies; Render-hosted, cold starts possible",
  },
  electronhub: {
    id: "electronhub",
    brand: "ElectronHub",
    baseUrl: "https://playground.electronhub.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "ELECTRONHUB_API_KEY",
    keyUrl: "https://playground.electronhub.ai",
    timeoutMs: 8000,
    rateLimitedHint: "community gateway — free tier available, stability varies",
  },
  xkiro: {
    id: "xkiro",
    brand: "Xkiro",
    baseUrl: "https://api.xkiro.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "XKIRO_API_KEY",
    keyUrl: "https://api.xkiro.com",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible — /v1/models works without key",
  },
  gonkarouter: {
    id: "gonkarouter",
    brand: "GonkaRouter",
    baseUrl: "https://gonkarouter.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "GONKAROUTER_API_KEY",
    keyUrl: "https://gonkarouter.io",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible router — key required",
  },
  bazaarlink: {
    id: "bazaarlink",
    brand: "BazaarLink",
    baseUrl: "https://api.bazaarlink.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "BAZAARLINK_API_KEY",
    keyUrl: "https://bazaarlink.ai",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI SDK drop-in — key required",
  },
  seldon: {
    id: "seldon",
    brand: "Seldon",
    baseUrl: "https://api.seldon-ai.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "SELDON_API_KEY",
    keyUrl: "https://seldon-ai.com",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  cavoti: {
    id: "cavoti",
    brand: "Cavoti",
    baseUrl: "https://cavoti.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "CAVOTI_API_KEY",
    keyUrl: "https://cavoti.com",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  freetheai: {
    id: "freetheai",
    brand: "FreeTheAI",
    baseUrl: "https://api.freetheai.xyz",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "FREETHEAI_API_KEY",
    keyUrl: "https://api.freetheai.xyz/v1",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  gmicloud: {
    id: "gmicloud",
    brand: "GMiCloud",
    baseUrl: "https://gmicloud.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "GMI_CLOUD_API_KEY",
    keyUrl: "https://gmicloud.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  inferx: {
    id: "inferx",
    brand: "InferX",
    baseUrl: "https://model.inferx.net",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "INFERX_API_KEY",
    keyUrl: "https://model.inferx.net/endpoints/v1",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  kkiai: {
    id: "kkiai",
    brand: "KKAI",
    baseUrl: "https://www.kkiai.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "KKIAI_API_KEY",
    keyUrl: "https://www.kkiai.com/v1",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  seekai: {
    id: "seekai",
    brand: "SeekAI",
    baseUrl: "https://seekai.cc",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "SEEKAI_API_KEY",
    keyUrl: "https://seekai.cc",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  getunikey: {
    id: "getunikey",
    brand: "UniKey",
    baseUrl: "https://www.getunikey.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "UNIKEY_API_KEY",
    keyUrl: "https://www.getunikey.ai/keys",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  bynara: {
    id: "bynara",
    brand: "Bynara",
    baseUrl: "https://router.bynara.id",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "BYNARA_API_KEY",
    keyUrl: "https://router.bynara.id",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible router — key required",
  },
  atria: {
    id: "atria",
    brand: "Atria",
    baseUrl: "https://api.atria-asi.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "ATRIA_API_KEY",
    keyUrl: "https://api.atria-asi.ai",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
  onerouter: {
    id: "onerouter",
    brand: "OneRouter",
    baseUrl: "https://llm.onerouter.pro",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "ONEROUTER_API_KEY",
    keyUrl: "https://llm.onerouter.pro",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible router — key required",
  },
  xpiki: {
    id: "xpiki",
    brand: "Xpiki",
    baseUrl: "https://api.xpiki.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "XPIKI_API_KEY",
    keyUrl: "https://api.xpiki.com",
    timeoutMs: 8000,
    rateLimitedHint: "OpenAI-compatible — key required",
  },
};

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