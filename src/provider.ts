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

/**
 * Builtin provider registry — adding a builtin is ONE table row, nothing else.
 * User-registered providers live outside this file (see custom-providers.ts:
 * `codewhip provider add`) and ride the same OpenAI-compatible ChatPort.
 * The loop only ever sees a ChatPort; openAiPort adapts any config.
 */

/** Builtins shipped with the install (llm7/tokenharbor/bai/fabryka: gateway tiers; the rest: free aggregators). */
export type BuiltinProviderId = "nvidia" | "mistral" | "sensenova" | "alibaba" | "llm7" | "tokenharbor" | "bai" | "fabryka" | "opencode" | "kilo" | "groq" | "cerebras" | "openrouter" | "gemini" | "zai" | "empero" | "pollinations" | "sambanova" | "chutes" | "hyperbolic" | "lepton" | "xai" | "huggingface" | "upstage" | "novita" | "parasail" | "volcengine" | "qianfan" | "hunyuan" | "moonshot" | "deepseek" | "minimax" | "stepfun" | "ppio";

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
  "lepton",
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
];

export function isBuiltinProviderId(value: string): value is BuiltinProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

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
    rateLimitedHint: "free-tier numbers unpublished — wait and retry",
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
    // clients that require one. In maintenance (503) at the 2026-09-11 probe.
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
    defaultModel: "mistral",
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
    baseUrl: "https://api.chutes.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-ai/DeepSeek-V3",
    envVar: "CHUTES_API_KEY",
    keyUrl: "https://chutes.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "rate-limited free tier (Bittensor decentralized)",
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
  lepton: {
    id: "lepton",
    brand: "lepton",
    baseUrl: "https://api.lepton.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "llama3-70b",
    envVar: "LEPTON_API_KEY",
    keyUrl: "https://lepton.ai",
    timeoutMs: DEFAULT_CHAT_TIMEOUT_MS,
    rateLimitedHint: "free quota on hosted open models",
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
};

export function parseProviderId(value: string | undefined): BuiltinProviderId | null {
  return (PROVIDER_IDS as readonly string[]).includes(value ?? "")
    ? (value as BuiltinProviderId)
    : null;
}

export function chatUrlFor(cfg: ProviderConfig): string {
  return `${cfg.baseUrl}${cfg.chatPath}`;
}

export function modelsUrlFor(cfg: ProviderConfig): string {
  return `${cfg.baseUrl}${cfg.modelsPath}`;
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

function genericHint(cfg: ProviderConfig): (status: number, body: string) => string {
  return (status, body) => {
    if (status === 401 || status === 403) {
      return `invalid or missing ${cfg.envVar} (get one at ${cfg.keyUrl})`;
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

/**
 * Parse a Retry-After header (delay seconds or HTTP-date) into ms,
 * capped at 60s. Undefined when absent, malformed, past, or wild.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    if (!Number.isFinite(ms) || ms < 0) {
      return undefined;
    }
    return Math.min(ms, 60000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  const diff = at - Date.now();
  if (diff < 0) {
    return undefined;
  }
  return Math.min(diff, 60000);
}

function httpFailure(
  status: number,
  body: string,
  hint: (status: number, body: string) => string,
  res: Response
): PortFailure {
  const retryable: RetryableKind =
    status === 429 ? "rate-limited" : status === 401 || status === 403 ? "auth" : "other";
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
  if (chunk.usage !== undefined) {
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

function openAiPort(cfg: ProviderConfig, apiKey: string, timeoutMs?: number): ChatPort {
  const brand = cfg.brand;
  const hint = genericHint(cfg);
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
        const url = `${hosts[i]}${cfg.chatPath}`;
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
                recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "ok", host: hosts[i], status: res.status, ms: Date.now() - callStart });
                const estimated = parsed.usage === null;
                const usage = parsed.usage ?? estimateUsage(body.length, parsed.text, parsed.toolCalls);
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
            recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "ok", host: hosts[i], status: res.status, ms });
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
            return {
              ok: true,
              text: content,
              toolCalls,
              promptTokens: toCount(data.usage?.prompt_tokens),
              completionTokens: toCount(data.usage?.completion_tokens),
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
export function makePortForConfig(cfg: ProviderConfig, apiKey: string, timeoutMs?: number): ChatPort {
  return openAiPort(cfg, apiKey, timeoutMs);
}

/** Tool-calling adapter implementing the loop's ChatPort for a builtin provider. */
export function makePort(provider: string, apiKey: string, timeoutMs?: number): ChatPort {
  const cfg = PROVIDERS[provider as BuiltinProviderId];
  if (cfg === undefined) {
    return async () => ({ ok: false, error: `unknown provider: ${provider}`, retryable: "other" });
  }
  return openAiPort(cfg, apiKey, timeoutMs);
}