/**
 * Builtin provider registry — pure data, zero imports.
 *
 * Single source of truth for the provider table. Kept as a zero-import
 * leaf: pure data stays out of the wire/auth machinery in provider.ts
 * (which needs node:fs for host pinning and key storage), and any future
 * non-Node consumer can reuse the table without dragging builtins in.
 * Adding a builtin is still ONE table row here and nothing else.
 */

/** Builtins shipped with the install (llm7/tokenharbor/bai/fabryka: gateway tiers; the rest: free aggregators). */
export type BuiltinProviderId = "nvidia" | "mistral" | "sensenova" | "alibaba" | "llm7" | "tokenharbor" | "bai" | "fabryka" | "opencode" | "kilo" | "groq" | "cerebras" | "openrouter" | "gemini" | "zai" | "empero" | "pollinations" | "sambanova" | "chutes" | "hyperbolic" | "xai" | "huggingface" | "upstage" | "novita" | "parasail" | "volcengine" | "qianfan" | "hunyuan" | "moonshot" | "deepseek" | "minimax" | "stepfun" | "ppio" | "cloudflare" | "modelscope" | "ovhcloud" | "ollama" | "cohere" | "siliconflow" | "aionlabs" | "agnes" | "requesty" | "inference" | "hetzner" | "venice" | "scaleway" | "friendli" | "nscale" | "nebius" | "ai21" | "coze" | "1min" | "hcnsec" | "hashneuron" | "anyrouter" | "apinex" | "zukijourney" | "nagaai" | "zanityai" | "kimetsu" | "navyapi" | "mnn" | "hcap" | "voltai" | "electronhub" | "xkiro" | "gonkarouter" | "bazaarlink" | "seldon" | "cavoti" | "getunikey" | "freetheai" | "gmicloud" | "inferx" | "kkiai" | "seekai" |   "bynara" | "atria" | "onerouter" | "xpiki" | "githubmodels" | "aihubmix" | "fastrouter" | "vercel" | "zenmux" | "llmgateway" | "together" | "deepinfra" | "fireworks" | "cometapi" | "suyu" | "voapi" | "nio" |   "mkeai" | "apiyi" | "codiv" | "openai" | "perplexity" | "writer" | "lambda" | "featherless" | "metallama" | "yi" | "baichuan" | "internlm" | "iflytek" | "reka" | "sarvam" | "typhoon" | "plamo" | "liquid" | "inception" | "nous" | "byteplus" | "xiaomi" | "arcee" | "heroku" | "modal" | "baseten" | "predibase" | "monsterapi" | "wandb" | "aimlapi" | "bytez" | "synthetic" | "nanogpt" | "kie" | "morph" | "galadriel" | "v0" | "factory" | "poe" | "wrouter" | "arouter" | "tokenrouter" | "darkbloom";

/** Any provider id: a builtin or a user-registered custom id. */
import type { ProviderId as ProviderIdFromPort } from "./provider-port.js";
export type ProviderId = ProviderIdFromPort;

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
  // 2026-09-18: completeness batch (freellm.sh + YoannDev90 + freellms.org +
  // nejib1 + llm24.net + ineed + findkey). First-party free tiers join
  // FREE_CHAIN; trial/paid aggregators and volatile relays stay builtins-only.
  "githubmodels", // GitHub Models free tier (Copilot-Free limits).
  "aihubmix", // AIHubMix free tier.
  "fastrouter", // FastRouter free models.
  "vercel", // Vercel AI Gateway free tier.
  "zenmux", // ZenMux $0/M-token models.
  "llmgateway", // LLM Gateway free=true models.
  "together", // Together AI trial credits — NOT free, builtin only.
  "deepinfra", // DeepInfra trial credits — NOT free, builtin only.
  "fireworks", // Fireworks AI trial credits — NOT free, builtin only.
  "cometapi", // CometAPI paid aggregator — NOT free, builtin only.
  "suyu", // Suyu free relay (daily call caps) — volatile, fast timeout.
  "voapi", // VoAPI gongyi relay (daily checkin quota) — volatile, fast timeout.
  "nio", // NIO gongyi-group relay — volatile, fast timeout.
  "mkeai", // MKEAI trial quota — NOT free, builtin only.
  "apiyi", // ApiYi trial quota — NOT free, builtin only.
  // 2026-09-18: codiv.ai — first-party OpenAI-compatible inference host
  // (DiffusionGemma 26B diffusion LM) with a native /v1/chat/completions.
  // Free per-account allotment "while the experiment runs" — renewable status
  // unconfirmed, so NOT in FREE_CHAIN (trial credit is not free).
  "codiv",
  // 2026-09-19: OmniRoute + awesome-freellm cross-harvest (deduped).
  "openai",
  "perplexity",
  "writer",
  "lambda",
  "featherless",
  "metallama",
  "yi",
  "baichuan",
  "internlm",
  "iflytek",
  "reka",
  "sarvam",
  "typhoon",
  "plamo",
  "liquid",
  "inception",
  "nous",
  "byteplus",
  "xiaomi",
  "arcee",
  "heroku",
  "modal",
  "baseten",
  "predibase",
  "monsterapi",
  "wandb",
  "aimlapi",
  "bytez",
  "synthetic",
  "nanogpt",
  "kie",
  "morph",
  "galadriel",
  "v0",
  "factory",
  "poe",
  // 2026-09-19: user-sourced gateways (docs-verified endpoints).
  "wrouter", // AccelsRouter trial credit — NOT free, builtin only.
  "arouter", // ARouter keyed gateway — NOT free, builtin only.
  // 2026-09-20: tokenrouter — OpenAI-compatible gateway routing 13 providers,
  // flat subscription, zero token markup. API key format tr_....
  "tokenrouter",
  // 2026-09-19: darkbloom.dev — private inference on attested Apple Silicon,
  // OpenAI-compatible (base https://api.darkbloom.dev/v1, keys eigeninference-*).
  // Prepaid credit, so builtin-only: NOT in FREE_CHAIN.
  "darkbloom",
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
  /** If true, the provider is hidden from catalogs and not routable. */
  disabled?: boolean;
  /**
   * Fallback key when no env/file key exists (llm7's anonymous "unused").
   * Runs still work keyless; `auth login` upgrades to higher limits.
   *
   * CRITICAL: providers with an `anonymousKey` must NOT receive a
   * Bearer token in the Authorization header. See the auth-header
   * rule in src/provider.ts (openAiPort): when keySource is
   * "anonymous", the Authorization header is omitted entirely.
   * Adding an anonymousKey without that guard breaks all keyless
   * providers (kilo, opencode, etc.) with spurious 400/401 errors.
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
  /**
   * Context window (tokens) of this row's DEFAULT model, set ONLY when
   * verified. The run's compaction ceiling derives from it (0.7×). Never
   * fiction: an unverified window stays undefined and keeps the default 60k
   * ceiling — a wrong number here either starves the model of context or
   * kills runs on small-window relays (see
   * docs/moat/torvalds-architecture-review.md). Windowless 400s are
   * reclassified as rotation-class so the run survives regardless.
   */
  contextWindow?: number;
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
    defaultModel: "auto",
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
  // === Completeness batch 2026-09-18 ===
  // Sources: freellm.sh, YoannDev90/awesome-free-ai-api, freellms.org,
  // nejib1/Free-LLM, llm24.net/providers, info.ineed.web.id/free-ai-resources,
  // findkey.openjoy.asia/sites.json. Default models are best-known slugs, NOT
  // live-probed: confirm with `codewhip models <id>` before relying on one.
  // First-party free tiers below join FREE_CHAIN; trial/paid rows stay out
  // (trial credit is not free — see free-providers.ts).
  githubmodels: {
    id: "githubmodels",
    brand: "githubmodels",
    baseUrl: "https://models.github.ai/inference",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "openai/gpt-4o-mini",
    envVar: "GITHUBMODELS_API_KEY",
    keyUrl: "https://github.com/marketplace/models",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier: 15 req/min low-tier models, 150 req/day (Copilot Free)",
  },
  aihubmix: {
    id: "aihubmix",
    brand: "aihubmix",
    baseUrl: "https://aihubmix.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "AIHUBMIX_API_KEY",
    keyUrl: "https://aihubmix.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier on open models — limits unpublished, wait and retry",
  },
  fastrouter: {
    id: "fastrouter",
    brand: "fastrouter",
    baseUrl: "https://go.fastrouter.ai",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "FASTROUTER_API_KEY",
    keyUrl: "https://fastrouter.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free models — limits unpublished, wait and retry",
  },
  vercel: {
    id: "vercel",
    brand: "vercel",
    baseUrl: "https://ai-gateway.vercel.sh",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "openai/gpt-4o-mini",
    envVar: "VERCEL_API_KEY",
    keyUrl: "https://vercel.com/ai-gateway",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free tier — provider-prefixed model ids (openai/..., anthropic/...)",
  },
  zenmux: {
    id: "zenmux",
    brand: "zenmux",
    baseUrl: "https://zenmux.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "ZENMUX_API_KEY",
    keyUrl: "https://zenmux.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "$0/M-token models — API key required, limits unpublished",
  },
  llmgateway: {
    id: "llmgateway",
    brand: "llmgateway",
    baseUrl: "https://llmgateway.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "LLMGATEWAY_API_KEY",
    keyUrl: "https://llmgateway.io",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free=true models — limits unpublished, wait and retry",
  },
  together: {
    id: "together",
    brand: "together",
    baseUrl: "https://api.together.xyz",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "TOGETHER_API_KEY",
    keyUrl: "https://api.together.xyz",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial credits (~$1 one-time) — NOT free, bills after the grant",
  },
  deepinfra: {
    id: "deepinfra",
    brand: "deepinfra",
    baseUrl: "https://api.deepinfra.ai/v1/openai",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "DEEPINFRA_API_KEY",
    keyUrl: "https://deepinfra.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial credits (~$5, 90-day expiry) — NOT free, bills after the grant",
  },
  fireworks: {
    id: "fireworks",
    brand: "fireworks",
    baseUrl: "https://api.fireworks.ai",
    chatPath: "/inference/v1/chat/completions",
    modelsPath: "/inference/v1/models",
    defaultModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    envVar: "FIREWORKS_API_KEY",
    keyUrl: "https://fireworks.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial credits (~$1 one-time) — NOT free, bills after the grant",
  },
  cometapi: {
    id: "cometapi",
    brand: "cometapi",
    baseUrl: "https://api.cometapi.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "COMETAPI_API_KEY",
    keyUrl: "https://cometapi.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "paid aggregator — no free tier, bills from the first call",
  },
  suyu: {
    id: "suyu",
    brand: "suyu",
    baseUrl: "https://free.suyu.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "SUYU_API_KEY",
    keyUrl: "https://free.suyu.io",
    timeoutMs: 8000,
    rateLimitedHint: "community relay: daily call caps (GPT-4o ~30/d, Mini ~200/d) — volatile, never send private code",
  },
  voapi: {
    id: "voapi",
    brand: "voapi",
    baseUrl: "https://demo.voapi.top",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "VOAPI_API_KEY",
    keyUrl: "https://demo.voapi.top",
    timeoutMs: 8000,
    rateLimitedHint: "community relay: daily checkin quota — volatile, never send private code",
  },
  nio: {
    id: "nio",
    brand: "nio",
    baseUrl: "https://api.nio.gs",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "NIO_API_KEY",
    keyUrl: "https://api.nio.gs",
    timeoutMs: 8000,
    rateLimitedHint: "community relay: free 公益 token group — volatile, never send private code",
  },
  mkeai: {
    id: "mkeai",
    brand: "mkeai",
    baseUrl: "https://api.mkeai.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "MKEAI_API_KEY",
    keyUrl: "https://api.mkeai.com",
    timeoutMs: 8000,
    rateLimitedHint: "trial quota (~$0.2 one-time) — NOT free, bills after the grant",
  },
  apiyi: {
    id: "apiyi",
    brand: "apiyi",
    baseUrl: "https://apiyi.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "APIYI_API_KEY",
    keyUrl: "https://apiyi.com",
    timeoutMs: 8000,
    rateLimitedHint: "trial quota (~$0.1 one-time) — NOT free, bills after the grant",
  },
  // Model id is from codiv's official API reference (only chat model listed),
  // not a harvested slug — still confirm with `codewhip models codiv`.
  // Diffusion LM: output denoised in 64-token blocks, completions take
  // seconds — the 120s default is correct here, not the relay timeout.
  codiv: {
    id: "codiv",
    brand: "codiv",
    baseUrl: "https://api.codiv.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "diffusiongemma-26b",
    envVar: "CODIV_API_KEY",
    keyUrl: "https://codiv.ai/signup",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free experiment tier: 600 req/min/key; insufficient_quota means the account's token grant is spent",
  },
  // 2026-09-19: OmniRoute + awesome-freellm cross-harvest (deduped against the
  // 96 existing builtins; same-backend dupes, oauth/cookie/IDE/web-scraper
  // entries, non-bearer auths, image/audio-only and SDK-only providers left
  // out — see free-chain.ts for why none of these join FREE_CHAIN).
  openai: {
    id: "openai",
    brand: "openai",
    baseUrl: "https://api.openai.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-5.6",
    envVar: "OPENAI_API_KEY",
    keyUrl: "https://platform.openai.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "no free tier — pay-go billing",
  },
  perplexity: {
    id: "perplexity",
    brand: "perplexity",
    baseUrl: "https://api.perplexity.ai",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    defaultModel: "sonar",
    envVar: "PERPLEXITY_API_KEY",
    keyUrl: "https://www.perplexity.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "metered search+models — see perplexity.ai settings/api",
  },
  writer: {
    id: "writer",
    brand: "writer",
    baseUrl: "https://api.writer.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "palmyra-x5",
    envVar: "WRITER_API_KEY",
    keyUrl: "https://writer.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see writer.com pricing",
  },
  lambda: {
    id: "lambda",
    brand: "lambda",
    baseUrl: "https://api.lambda.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-r1-671b",
    envVar: "LAMBDA_API_KEY",
    keyUrl: "https://lambda.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed inference — see lambda.ai pricing",
  },
  featherless: {
    id: "featherless",
    brand: "featherless",
    baseUrl: "https://api.featherless.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "featherless-ai/Qwerky-72B",
    envVar: "FEATHERLESS_API_KEY",
    keyUrl: "https://featherless.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free models with rate limits — see featherless.ai",
  },
  metallama: {
    id: "metallama",
    brand: "metallama",
    baseUrl: "https://api.llama.com",
    chatPath: "/compat/v1/chat/completions",
    modelsPath: "/compat/v1/models",
    defaultModel: "Llama-4-Maverick-17B-128E-Instruct-FP8",
    envVar: "LLAMA_API_KEY",
    keyUrl: "https://www.llama.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed Llama API — free-tier limits unpublished",
  },
  yi: {
    id: "yi",
    brand: "yi",
    baseUrl: "https://api.lingyiwanwu.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "yi-large",
    envVar: "YI_API_KEY",
    keyUrl: "https://api.lingyiwanwu.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see 01.AI open platform",
  },
  baichuan: {
    id: "baichuan",
    brand: "baichuan",
    baseUrl: "https://api.baichuan-ai.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Baichuan4-Turbo",
    envVar: "BAICHUAN_API_KEY",
    keyUrl: "https://www.baichuan-ai.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial quota for new keys — see Baichuan platform",
  },
  internlm: {
    id: "internlm",
    brand: "internlm",
    baseUrl: "https://chat.intern-ai.org.cn",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "intern-s1-pro",
    envVar: "INTERNLM_API_KEY",
    keyUrl: "https://intern-ai.org.cn",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see InternLM platform",
  },
  iflytek: {
    id: "iflytek",
    brand: "iflytek",
    baseUrl: "https://spark-api-open.xf-yun.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "4.0Ultra",
    envVar: "IFLYTEK_API_KEY",
    keyUrl: "https://www.xfyun.cn",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Spark API — free quota for new apps",
  },
  reka: {
    id: "reka",
    brand: "reka",
    baseUrl: "https://api.reka.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "reka-flash-3",
    envVar: "REKA_API_KEY",
    keyUrl: "https://www.reka.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "monthly free allowance — see reka.ai",
  },
  sarvam: {
    id: "sarvam",
    brand: "sarvam",
    baseUrl: "https://api.sarvam.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "sarvam-105b",
    envVar: "SARVAM_API_KEY",
    keyUrl: "https://www.sarvam.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see sarvam.ai pricing",
  },
  typhoon: {
    id: "typhoon",
    brand: "typhoon",
    baseUrl: "https://api.opentyphoon.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "typhoon-v2.5-30b-a3b-instruct",
    envVar: "TYPHOON_API_KEY",
    keyUrl: "https://api.opentyphoon.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — limits unpublished",
  },
  plamo: {
    id: "plamo",
    brand: "plamo",
    baseUrl: "https://api.platform.preferredai.jp",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "plamo-3.0-prime",
    envVar: "PLAMO_API_KEY",
    keyUrl: "https://platform.preferredai.jp",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see PreferredAI platform",
  },
  liquid: {
    id: "liquid",
    brand: "liquid",
    baseUrl: "https://inference.liquid.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "liquid-lfm-40b",
    envVar: "LIQUID_API_KEY",
    keyUrl: "https://www.liquid.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see liquid.ai",
  },
  inception: {
    id: "inception",
    brand: "inception",
    baseUrl: "https://api.inceptionlabs.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mercury-2",
    envVar: "INCEPTION_API_KEY",
    keyUrl: "https://api.inceptionlabs.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — limits unpublished",
  },
  nous: {
    id: "nous",
    brand: "nous",
    baseUrl: "https://inference-api.nousresearch.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Hermes-4-405B",
    envVar: "NOUS_API_KEY",
    keyUrl: "https://nousresearch.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Forge subscription API — see nousresearch.com",
  },
  byteplus: {
    id: "byteplus",
    brand: "byteplus",
    baseUrl: "https://ark.ap-southeast.bytepluses.com",
    chatPath: "/api/v3/chat/completions",
    modelsPath: "/api/v3/models",
    defaultModel: "seed-2.0",
    envVar: "BYTEPLUS_API_KEY",
    keyUrl: "https://www.byteplus.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Ark platform — free quota for new keys",
  },
  xiaomi: {
    id: "xiaomi",
    brand: "xiaomi",
    baseUrl: "https://api.xiaomimimo.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mimo-v2.5-pro",
    envVar: "XIAOMI_API_KEY",
    keyUrl: "https://api.xiaomimimo.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — limits unpublished",
  },
  arcee: {
    id: "arcee",
    brand: "arcee",
    baseUrl: "https://api.arcee.ai",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "arcee-ai/trinity-large-preview:free",
    envVar: "ARCEE_API_KEY",
    keyUrl: "https://arcee.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "daily free allowance on :free endpoints",
  },
  heroku: {
    id: "heroku",
    brand: "heroku",
    baseUrl: "https://us.inference.heroku.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "claude-opus-4-7",
    envVar: "HEROKU_API_KEY",
    keyUrl: "https://www.heroku.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Heroku Inference — keyed, usage billed",
  },
  modal: {
    id: "modal",
    brand: "modal",
    baseUrl: "https://api.modal.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "google/gemini-2.0-flash",
    envVar: "MODAL_API_KEY",
    keyUrl: "https://modal.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Modal inference — keyed, GPU-second billing",
  },
  baseten: {
    id: "baseten",
    brand: "baseten",
    baseUrl: "https://inference.baseten.co",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "moonshotai/Kimi-K2.6",
    envVar: "BASETEN_API_KEY",
    keyUrl: "https://www.baseten.co",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial credits for new accounts — not a free tier",
  },
  predibase: {
    id: "predibase",
    brand: "predibase",
    baseUrl: "https://serving.app.predibase.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "llama-3.3-70b",
    envVar: "PREDIBASE_API_KEY",
    keyUrl: "https://predibase.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "one-time credit grant — not a free tier",
  },
  monsterapi: {
    id: "monsterapi",
    brand: "monsterapi",
    baseUrl: "https://api.monsterapi.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Meta-Llama-3.1-8B-Instruct",
    envVar: "MONSTERAPI_API_KEY",
    keyUrl: "https://monsterapi.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "one-time credits — not a free tier",
  },
  wandb: {
    id: "wandb",
    brand: "wandb",
    baseUrl: "https://api.inference.wandb.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "openai/gpt-oss-120b",
    envVar: "WANDB_API_KEY",
    keyUrl: "https://wandb.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "W&B Inference — keyed API",
  },
  aimlapi: {
    id: "aimlapi",
    brand: "aimlapi",
    baseUrl: "https://api.aimlapi.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o",
    envVar: "AIMLAPI_API_KEY",
    keyUrl: "https://aimlapi.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free-tier models with limits — see aimlapi.com",
  },
  bytez: {
    id: "bytez",
    brand: "bytez",
    baseUrl: "https://api.bytez.com",
    chatPath: "/models/v2/openai/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct",
    envVar: "BYTEZ_API_KEY",
    keyUrl: "https://bytez.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "recurring credit allowance — see bytez.com",
  },
  synthetic: {
    id: "synthetic",
    brand: "synthetic",
    baseUrl: "https://api.synthetic.new",
    chatPath: "/openai/v1/chat/completions",
    modelsPath: "/openai/v1/models",
    defaultModel: "hf:openai/gpt-oss-120b",
    envVar: "SYNTHETIC_API_KEY",
    keyUrl: "https://synthetic.new",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "HF-mirrored inference — keyed, see synthetic.new",
  },
  nanogpt: {
    id: "nanogpt",
    brand: "nanogpt",
    baseUrl: "https://nano-gpt.com",
    chatPath: "/api/v1/chat/completions",
    modelsPath: "/api/v1/models",
    defaultModel: "chatgpt-4o-latest",
    envVar: "NANOGPT_API_KEY",
    keyUrl: "https://nano-gpt.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "pay-per-use relay — see nano-gpt.com",
  },
  kie: {
    id: "kie",
    brand: "kie",
    baseUrl: "https://api.kie.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "claude-fable-5",
    envVar: "KIE_API_KEY",
    keyUrl: "https://kie.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see kie.ai pricing",
  },
  morph: {
    id: "morph",
    brand: "morph",
    baseUrl: "https://api.morphllm.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "morph-v3-large",
    envVar: "MORPH_API_KEY",
    keyUrl: "https://www.morphllm.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "monthly free allowance — see morphllm.com",
  },
  galadriel: {
    id: "galadriel",
    brand: "galadriel",
    baseUrl: "https://api.galadriel.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "galadriel-latest",
    envVar: "GALADRIEL_API_KEY",
    keyUrl: "https://api.galadriel.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "decentralized inference — keyed, limits unpublished",
  },
  v0: {
    id: "v0",
    brand: "v0",
    baseUrl: "https://api.v0.dev",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "v0-1.0-md",
    envVar: "V0_API_KEY",
    keyUrl: "https://v0.dev",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "v0 API — keyed, token billing",
  },
  factory: {
    id: "factory",
    brand: "factory",
    baseUrl: "https://api.factory.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "auto",
    envVar: "FACTORY_API_KEY",
    keyUrl: "https://www.factory.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed API — see factory.ai",
  },
  poe: {
    id: "poe",
    brand: "poe",
    baseUrl: "https://api.poe.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-5.2",
    envVar: "POE_API_KEY",
    keyUrl: "https://poe.com",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "Poe API — subscription/points billed",
  },
  // 2026-09-19: user-sourced gateways, endpoint facts verified against the
  // providers' own docs (quick-start pages). Both keyed, neither with a
  // verified renewable free tier — builtin-only, out of FREE_CHAIN.
  wrouter: {
    id: "wrouter",
    brand: "wrouter",
    baseUrl: "https://router.accels.tech",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "WROUTER_API_KEY",
    keyUrl: "https://router.accels.tech/register",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "trial credit for new accounts — not a free tier",
  },
  arouter: {
    id: "arouter",
    brand: "arouter",
    baseUrl: "https://api.arouter.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "openai/gpt-5.4",
    envVar: "AROUTER_API_KEY",
    keyUrl: "https://api.arouter.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "keyed gateway — see arouter.ai pricing",
  },
  tokenrouter: {
    id: "tokenrouter",
    brand: "tokenrouter",
    baseUrl: "https://api.tokenrouter.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "auto",
    envVar: "TOKENROUTER_API_KEY",
    keyUrl: "https://docs.tokenrouter.io",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "14-day free trial, then flat subscription — no card on free plan; 403 auto_routing_unavailable on free tier with auto model",
  },
  // 2026-09-19: darkbloom.dev — private inference on attested Apple Silicon
  // (Layr-Labs d-inference). OpenAI-compatible; keys start with
  // "eigeninference-". Prepaid credit: user carries a 150M-token balance for
  // the prism-family model. Deliberately NOT in FREE_CHAIN.
  darkbloom: {
    id: "darkbloom",
    brand: "darkbloom",
    baseUrl: "https://api.darkbloom.dev",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "ternary-bonsai-2-27b",
    envVar: "DARKBLOOM_API_KEY",
    keyUrl: "https://console.darkbloom.dev/api-console",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    contextWindow: 262144,
  },
};
