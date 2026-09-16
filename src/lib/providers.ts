/**
 * Complete Provider Registry for CodeWhip Proxy
 * 
 * This module contains the full provider registry extracted from the CLI,
 * including all 35+ builtin providers, custom provider support, and model
 * discovery with agency annotations.
 */

import type { ProviderId, ProviderConfig } from "./types.js";

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
// Builtin Provider Registry (Complete)
// ============================================================================

export const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  // --- Core free-tier providers ---
  nvidia: {
    id: "nvidia",
    brand: "nvidia",
    baseUrl: "https://build.nvidia.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta/llama-3.1-405b-instruct",
    envVar: "NVIDIA_API_KEY",
    keyUrl: "https://build.nvidia.com/settings/api-keys",
    timeoutMs: 30000,
    rateLimitedHint: "free models: 30 req/min, 60k tokens/min",
  },
  mistral: {
    id: "mistral",
    brand: "mistral",
    baseUrl: "https://api.mistral.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mistral-small-latest",
    envVar: "MISTRAL_API_KEY",
    keyUrl: "https://console.mistral.ai/settings/api-keys",
    timeoutMs: 30000,
    rateLimitedHint: "free mode is evaluation-grade: RPS + tokens/min + tokens/month caps — check Limits",
  },
  sensenova: {
    id: "sensenova",
    brand: "sensenova",
    baseUrl: "https://api.sensenova.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "sensenova-6.8-flash-lite",
    envVar: "SENSENOVA_API_KEY",
    keyUrl: "https://token.sensenova.ai",
    timeoutMs: 30000,
  },
  alibaba: {
    id: "alibaba",
    brand: "alibaba",
    baseUrl: "https://dashscope-intl.aliyuncs.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "qwen-plus",
    envVar: "ALIBABA_API_KEY",
    keyUrl: "https://dashscope-intl.aliyun.com",
    timeoutMs: 30000,
  },
  llm7: {
    id: "llm7",
    brand: "llm7",
    baseUrl: "https://api.llm7.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-v3",
    envVar: "LLM7_API_KEY",
    keyUrl: "https://dash.llm7.io",
    timeoutMs: 30000,
    anonymousKey: "unused",
  },
  tokenharbor: {
    id: "tokenharbor",
    brand: "tokenharbor",
    baseUrl: "https://api.tokenharbor.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-v3",
    envVar: "TOKENHARBOR_API_KEY",
    keyUrl: "https://tokenharbor.ai/dashboard/api-keys",
    timeoutMs: 30000,
  },
  bai: {
    id: "bai",
    brand: "bai",
    baseUrl: "https://api.bai.chat",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o-mini",
    envVar: "BAI_API_KEY",
    keyUrl: "https://chat.b.ai/chat",
    timeoutMs: 30000,
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
    timeoutMs: 30000,
  },
  opencode: {
    id: "opencode",
    brand: "opencode",
    baseUrl: "https://opencode.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mimo-v2.5-free",
    envVar: "OPENCODE_API_KEY",
    keyUrl: "https://opencode.ai/zen",
    timeoutMs: 30000,
  },
  kilo: {
    id: "kilo",
    brand: "kilo",
    baseUrl: "https://api.kilo.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "cohere/north-mini-code:free",
    envVar: "KILO_API_KEY",
    keyUrl: "https://kilo.ai",
    timeoutMs: 30000,
    anonymousKey: "free",
  },
  groq: {
    id: "groq",
    brand: "groq",
    baseUrl: "https://api.groq.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "openai/gpt-oss-120b",
    envVar: "GROQ_API_KEY",
    keyUrl: "https://console.groq.com/keys",
    timeoutMs: 30000,
  },
  cerebras: {
    id: "cerebras",
    brand: "cerebras",
    baseUrl: "https://api.cerebras.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "llama-3.3-70b",
    envVar: "CEREBRAS_API_KEY",
    keyUrl: "https://cloud.cerebras.ai",
    timeoutMs: 30000,
  },
  openrouter: {
    id: "openrouter",
    brand: "openrouter",
    baseUrl: "https://openrouter.ai/api",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "nvidia/nemotron-3-super-120b-a12b:free",
    envVar: "OPENROUTER_API_KEY",
    keyUrl: "https://openrouter.ai/keys",
    timeoutMs: 30000,
  },
  gemini: {
    id: "gemini",
    brand: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    chatPath: "/v1beta/models",
    modelsPath: "/v1beta/models",
    defaultModel: "gemini-1.5-flash",
    envVar: "GEMINI_API_KEY",
    keyUrl: "https://aistudio.google.com/apikey",
    timeoutMs: 30000,
  },
  zai: {
    id: "zai",
    brand: "zai",
    baseUrl: "https://api.z.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "glm-5.3-flash",
    envVar: "ZAI_API_KEY",
    keyUrl: "https://z.ai",
    timeoutMs: 30000,
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
    timeoutMs: 30000,
    anonymousKey: "free",
  },
  pollinations: {
    id: "pollinations",
    brand: "pollinations",
    baseUrl: "https://text.pollinations.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "openai",
    envVar: "POLLINATIONS_API_KEY",
    keyUrl: "https://pollinations.ai",
    timeoutMs: 30000,
  },

  // --- 2026-09-11 onboarded free OpenAI-compatible providers ---
  sambanova: {
    id: "sambanova",
    brand: "sambanova",
    baseUrl: "https://api.sambanova.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Meta-Llama-3.1-405B-Instruct",
    envVar: "SAMBANOVA_API_KEY",
    keyUrl: "https://cloud.sambanova.ai",
    timeoutMs: 30000,
  },
  chutes: {
    id: "chutes",
    brand: "chutes",
    baseUrl: "https://llm.chutes.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "deepseek-v3",
    envVar: "CHUTES_API_KEY",
    keyUrl: "https://chutes.ai",
    timeoutMs: 30000,
  },
  hyperbolic: {
    id: "hyperbolic",
    brand: "hyperbolic",
    baseUrl: "https://api.hyperbolic.xyz",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    envVar: "HYPERBOLIC_API_KEY",
    keyUrl: "https://hyperbolic.xyz",
    timeoutMs: 30000,
  },
  xai: {
    id: "xai",
    brand: "xai",
    baseUrl: "https://api.x.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "grok-beta",
    envVar: "XAI_API_KEY",
    keyUrl: "https://console.x.ai",
    timeoutMs: 30000,
  },
  huggingface: {
    id: "huggingface",
    brand: "huggingface",
    baseUrl: "https://api-inference.huggingface.co",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mistralai/Mistral-7B-Instruct-v0.1",
    envVar: "HUGGINGFACE_API_KEY",
    keyUrl: "https://huggingface.co/settings/tokens",
    timeoutMs: 30000,
  },
  upstage: {
    id: "upstage",
    brand: "upstage",
    baseUrl: "https://api.upstage.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "solar-1-mini-chat",
    envVar: "UPSTAGE_API_KEY",
    keyUrl: "https://console.upstage.ai",
    timeoutMs: 30000,
  },
  novita: {
    id: "novita",
    brand: "novita",
    baseUrl: "https://api.novita.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/llama-3.1-405b-instruct",
    envVar: "NOVITA_API_KEY",
    keyUrl: "https://novita.ai",
    timeoutMs: 30000,
  },
  parasail: {
    id: "parasail",
    brand: "parasail",
    baseUrl: "https://api.parasail.io",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/llama-3.1-405b-instruct",
    envVar: "PARASAIL_API_KEY",
    keyUrl: "https://parasail.io",
    timeoutMs: 30000,
  },
  volcengine: {
    id: "volcengine",
    brand: "volcengine",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "doubao-pro-32k",
    envVar: "VOLCENGINE_API_KEY",
    keyUrl: "https://console.volcengine.com/ark",
    timeoutMs: 30000,
  },
  qianfan: {
    id: "qianfan",
    brand: "qianfan",
    baseUrl: "https://qianfan.baidubce.com/v2",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "ERNIE-4.0-8K",
    envVar: "QIANFAN_API_KEY",
    keyUrl: "https://qianfan.baidu.com",
    timeoutMs: 30000,
  },
  hunyuan: {
    id: "hunyuan",
    brand: "hunyuan",
    baseUrl: "https://api.hunyuan.cloud.tencent.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "hunyuan-standard",
    envVar: "HUNYUAN_API_KEY",
    keyUrl: "https://console.cloud.tencent.com/hunyuan",
    timeoutMs: 30000,
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
    timeoutMs: 30000,
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
    timeoutMs: 30000,
  },
  minimax: {
    id: "minimax",
    brand: "minimax",
    baseUrl: "https://api.minimax.chat",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "abab6.5-chat",
    envVar: "MINIMAX_API_KEY",
    keyUrl: "https://api.minimax.chat",
    timeoutMs: 30000,
  },
  stepfun: {
    id: "stepfun",
    brand: "stepfun",
    baseUrl: "https://api.stepfun.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "step-2-mini",
    envVar: "STEPFUN_API_KEY",
    keyUrl: "https://platform.stepfun.com",
    timeoutMs: 30000,
  },
  ppio: {
    id: "ppio",
    brand: "ppio",
    baseUrl: "https://api.ppinfra.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/llama-3.1-405b-instruct",
    envVar: "PPIO_API_KEY",
    keyUrl: "https://ppinfra.com",
    timeoutMs: 30000,
  },

  // --- 2026-09-13 free-tier candidates ---
  cloudflare: {
    id: "cloudflare",
    brand: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "@cf/metallama/llama-2-7b-chat-fp16",
    envVar: "CLOUDFLARE_API_KEY",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    timeoutMs: 30000,
  },
  modelscope: {
    id: "modelscope",
    brand: "modelscope",
    baseUrl: "https://api-inference.modelscope.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    envVar: "MODELSCOPE_API_KEY",
    keyUrl: "https://modelscope.cn",
    timeoutMs: 30000,
  },
  ovhcloud: {
    id: "ovhcloud",
    brand: "ovhcloud",
    baseUrl: "https://ai.endpoints.ovhcloud.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Mistral-7B-Instruct-v0.3",
    envVar: "OVHCLOUD_API_KEY",
    keyUrl: "https://ai.endpoints.ovhcloud.com",
    timeoutMs: 30000,
  },
  ollama: {
    id: "ollama",
    brand: "ollama",
    baseUrl: "https://api.ollama.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "qwen3:35b",
    envVar: "OLLAMA_API_KEY",
    keyUrl: "https://ollama.com",
    timeoutMs: 30000,
  },
  cohere: {
    id: "cohere",
    brand: "cohere",
    baseUrl: "https://api.cohere.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "command-r-plus",
    envVar: "COHERE_API_KEY",
    keyUrl: "https://dashboard.cohere.com/api-keys",
    timeoutMs: 30000,
  },
  siliconflow: {
    id: "siliconflow",
    brand: "siliconflow",
    baseUrl: "https://api.siliconflow.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "Qwen/Qwen2.5-72B-Instruct",
    envVar: "SILICONFLOW_API_KEY",
    keyUrl: "https://cloud.siliconflow.cn",
    timeoutMs: 30000,
  },
  aionlabs: {
    id: "aionlabs",
    brand: "aionlabs",
    baseUrl: "https://api.aionlabs.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "qwen2.5-72b-instruct",
    envVar: "AIONLABS_API_KEY",
    keyUrl: "https://aionlabs.ai",
    timeoutMs: 30000,
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
    timeoutMs: 30000,
  },
  requesty: {
    id: "requesty",
    brand: "requesty",
    baseUrl: "https://router.requesty.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "openrouter/auto",
    envVar: "REQUESTY_API_KEY",
    keyUrl: "https://requesty.ai",
    timeoutMs: 30000,
  },
  inference: {
    id: "inference",
    brand: "inference",
    baseUrl: "https://api.inference.net",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    envVar: "INFERENCE_API_KEY",
    keyUrl: "https://inference.net",
    timeoutMs: 30000,
  },
  hetzner: {
    id: "hetzner",
    brand: "hetzner",
    baseUrl: "https://inference.hetzner.cloud",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    envVar: "HETZNER_API_KEY",
    keyUrl: "https://console.hetzner.cloud",
    timeoutMs: 30000,
  },
  venice: {
    id: "venice",
    brand: "venice",
    baseUrl: "https://api.venice.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "dolphin-2.9.2-qwen2-72b",
    envVar: "VENICE_API_KEY",
    keyUrl: "https://venice.ai",
    timeoutMs: 30000,
  },
  scaleway: {
    id: "scaleway",
    brand: "scaleway",
    baseUrl: "https://api.scaleway.com/ai/v1",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "mistral-7b-instruct-v0.3",
    envVar: "SCALEWAY_API_KEY",
    keyUrl: "https://console.scaleway.com",
    timeoutMs: 30000,
  },
  friendli: {
    id: "friendli",
    brand: "friendli",
    baseUrl: "https://api.friendli.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/llama-3.1-405b-instruct",
    envVar: "FRIENDLI_API_KEY",
    keyUrl: "https://friendli.ai",
    timeoutMs: 30000,
  },
  nscale: {
    id: "nscale",
    brand: "nscale",
    baseUrl: "https://inference.nscale.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    envVar: "NSCALE_API_KEY",
    keyUrl: "https://nscale.ai",
    timeoutMs: 30000,
  },
  nebius: {
    id: "nebius",
    brand: "nebius",
    baseUrl: "https://api.studio.nebius.ai",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "meta-llama/Meta-Llama-3.1-405B-Instruct",
    envVar: "NEBIUS_API_KEY",
    keyUrl: "https://studio.nebius.com/settings/api-keys",
    timeoutMs: 30000,
  },
  ai21: {
    id: "ai21",
    brand: "ai21",
    baseUrl: "https://api.ai21.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "jamba-1.5-mini",
    envVar: "AI21_API_KEY",
    keyUrl: "https://console.ai21.com/api-key",
    timeoutMs: 30000,
  },
  coze: {
    id: "coze",
    brand: "coze",
    baseUrl: "https://api.coze.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "gpt-4o",
    envVar: "COZE_API_KEY",
    keyUrl: "https://coze.com",
    timeoutMs: 30000,
  },

  // --- Special providers ---
  "1min": {
    id: "1min",
    brand: "1min",
    baseUrl: "https://api.1min.ai",
    chatPath: "/v1/unify-chat-with-ai",
    modelsPath: "/v1/models",
    defaultModel: "auto",
    envVar: "ONEMIN_API_KEY",
    keyUrl: "https://1min.ai/settings/api-keys",
    timeoutMs: 30000,
    port: "onemin",
  },
  hcnsec: {
    id: "hcnsec",
    brand: "hcnsec",
    baseUrl: "https://api.hcnsec.cn",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "auto",
    envVar: "HCNSEC_API_KEY",
    keyUrl: "https://api.hcnsec.cn/console",
    timeoutMs: 30000,
  },
  hashneuron: {
    id: "hashneuron",
    brand: "hashneuron",
    baseUrl: "https://hashneuron.space",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
    defaultModel: "default",
    envVar: "HASHNEURON_API_KEY",
    keyUrl: "https://hashneuron.space/#keys",
    timeoutMs: 30000,
  },
};

// ============================================================================
// Provider Helper Functions
// ============================================================================

export function isBuiltinProviderId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, id);
}

export function getProviderConfig(id: ProviderId): ProviderConfig | undefined {
  return PROVIDERS[id];
}

export function listBuiltinProviderIds(): ProviderId[] {
  return Object.keys(PROVIDERS) as ProviderId[];
}

export function listBuiltinProviderConfigs(): ProviderConfig[] {
  return Object.values(PROVIDERS);
}

// ============================================================================
// Free Chain (for --free runs)
// ============================================================================

export type FreeProviderEntry = {
  id: ProviderId;
  freeOffer: string;
  keyNeeded: "no" | "free-key";
  limits: string;
};

export const FREE_CHAIN: readonly FreeProviderEntry[] = [
  { id: "kilo", freeOffer: "Kilo gateway ':free' models — anonymous, no key, no headers", keyNeeded: "no", limits: "free-model daily caps unpublished — wait and retry" },
  { id: "opencode", freeOffer: "OpenCode Zen free models — anonymous ('public' key + identity headers, handled by codewhip)", keyNeeded: "no", limits: "small per-IP anonymous quota (FreeUsageLimitError on 429); published quotas none" },
  { id: "empero", freeOffer: "Empero free endpoint (glm-5.3-flash) — no signup; prompts may be logged", keyNeeded: "no", limits: "unpublished; declared maintenance since >= 2026-09-11 (503 'maintenance' on re-probe 2026-09-14) — model set changing, re-verify on return" },
  { id: "pollinations", freeOffer: "Pollinations.ai — anonymous, no key, no signup (OpenAI-compatible text+image)", keyNeeded: "no", limits: "per-IP rate-limited (~1 req/s) — back off and retry" },
  { id: "groq", freeOffer: "Groq free tier on open models", keyNeeded: "free-key", limits: "~30 req/min per model, ~14.4k req/day" },
  { id: "openrouter", freeOffer: "OpenRouter :free models", keyNeeded: "free-key", limits: "50 req/day without credits; 1000/day after a $10 credit purchase" },
  { id: "gemini", freeOffer: "Gemini free tier (flash)", keyNeeded: "free-key", limits: "small in 2026 (tens of req/day) — wait and retry" },
  { id: "zai", freeOffer: "GLM flash free (limited-time promo)", keyNeeded: "free-key", limits: "free status is limited-time — expect quota errors when the promo ends" },
  { id: "nvidia", freeOffer: "NVIDIA-hosted open models", keyNeeded: "free-key", limits: "~40 req/min" },
  { id: "mistral", freeOffer: "Mistral free mode", keyNeeded: "free-key", limits: "caps RPS + tokens/min + tokens/month — see Limits in console.mistral.ai" },
  { id: "sambanova", freeOffer: "SambaNova Cloud free tier (fast RDU inference)", keyNeeded: "free-key", limits: "~200k tokens/day" },
  { id: "hyperbolic", freeOffer: "Hyperbolic free daily credits", keyNeeded: "free-key", limits: "free daily allowance on open models" },
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
  { id: "cloudflare", freeOffer: "Cloudflare Workers AI — edge-hosted open models", keyNeeded: "free-key", limits: "10k neurons/day shared across models; needs CLOUDFLARE_ACCOUNT_ID too" },
  { id: "modelscope", freeOffer: "ModelScope Inference API (Alibaba) — newest Qwen", keyNeeded: "free-key", limits: "2,000 req/day total, <=500/day per model; real-name verification required" },
  { id: "ovhcloud", freeOffer: "OVHcloud AI Endpoints — EU-hosted open models", keyNeeded: "free-key", limits: "400 req/min authenticated (2 req/min anonymous); service in beta" },
  { id: "ollama", freeOffer: "Ollama Cloud — hosted gpt-oss / Qwen / DeepSeek", keyNeeded: "free-key", limits: "light tier: 1 concurrent model, session + weekly caps" },
  { id: "cohere", freeOffer: "Cohere trial key — Command models", keyNeeded: "free-key", limits: "20 req/min, ~1,000 req/month shared across models" },
  { id: "siliconflow", freeOffer: "SiliconFlow free models", keyNeeded: "free-key", limits: "30 req/min, 60k tokens/min; identity verification required" },
  { id: "aionlabs", freeOffer: "Aion Labs daily token allowance", keyNeeded: "free-key", limits: "~15 req/min, ~20k tokens/day; no card" },
  { id: "agnes", freeOffer: "Agnes AI flash models", keyNeeded: "free-key", limits: "~30 req/min" },
  { id: "requesty", freeOffer: "Requesty router — free model tier", keyNeeded: "free-key", limits: "60 req/min, 200 req/day on free models" },
  { id: "inference", freeOffer: "Inference.net open-model endpoints", keyNeeded: "free-key", limits: "~30 req/min under a fair-use policy" },
  { id: "hetzner", freeOffer: "Hetzner Inference API — experimental, EU-hosted", keyNeeded: "free-key", limits: "no SLA; 3M in / 60k out tokens per 60s while experimental" },
  { id: "venice", freeOffer: "Venice.ai privacy-first models", keyNeeded: "free-key", limits: "10 req/min; provider advertises no prompt logging" },
  { id: "scaleway", freeOffer: "Scaleway Generative APIs — EU/GDPR-hosted", keyNeeded: "free-key", limits: "1M free tokens one-time per model" },
  { id: "friendli", freeOffer: "Friendli Inference trial credits", keyNeeded: "free-key", limits: "$10 one-time trial credits; ~60 req/min" },
  { id: "nscale", freeOffer: "Nscale inference — no card required", keyNeeded: "free-key", limits: "$5 one-time signup credit, then fair-use metering" },
  { id: "nebius", freeOffer: "Nebius Token Factory", keyNeeded: "free-key", limits: "$1 free grant (card on file required); ~60 req/min" },
  { id: "ai21", freeOffer: "AI21 Studio — Jamba models", keyNeeded: "free-key", limits: "$10 trial credits expiring after 3 months; 200 req/min" },
  { id: "coze", freeOffer: "Coze (ByteDance) hosted bots — GPT-4o-class via proxy", keyNeeded: "free-key", limits: "token-metered with daily resets; varies per proxied model" },
  { id: "llm7", freeOffer: "anonymous gateway — works with no key at all", keyNeeded: "no", limits: "heavily rate-limited; a free dash.llm7.io token raises limits" },
];

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
  "meta/llama-3.1-405b-instruct": { tag: "agent", note: "codewhip default; ran the tool loop in testing (2026-09-08)" },
  // alibaba
  "qwen-plus": { tag: "untested", note: "codewhip default; documented tool-caller, no live probe yet" },
  // sensenova
  "sensenova-6.8-flash-lite": { tag: "untested", note: "codewhip default; agency unknown (no live probe yet)" },
  // llm7
  "deepseek-v3": { tag: "untested", note: "llm7 gateway default; OpenAI-compatible, no live probe yet" },
  // tokenharbor
  // bai
  // fabryka
  // kilo
  "cohere/north-mini-code:free": { tag: "untested", note: "codewhip default; ':free' models anonymous; a tool-call round verified 2026-09-11, no full agent-loop probe" },
  // opencode
  "mimo-v2.5-free": { tag: "untested", note: "zen free tier verified keyless 2026-09-11 (identity-header gated, small per-IP quota); no tool-loop probe yet" },
  // groq, zai, openrouter
  // cerebras, gemini
  // empero
  // mistral
  "ministral-14b-latest": { tag: "agent", note: "small/fast family; tool loop probed on 14b (2026-09-10)" },
  "mistral-small-latest": { tag: "untested", note: "codewhip default; documented tool-caller, live probes 429-gated (2026-09-10)" },
  "mistral-medium-latest": { tag: "untested", note: "documented tool-caller, live probes 429-gated (2026-09-10)" },
  "magistral-small-2506": { tag: "untested", note: "reasoning family; 429-gated, no live probe (2026-09-10)" },
};

function annotateModel(provider: string, id: string): { tag: AgencyTag; note: string } {
  // Check specific known models first
  if (AGENCY_NOTES[id]) return AGENCY_NOTES[id];
  
  const def = PROVIDERS[provider]?.defaultModel;
  
  // Provider-level defaults
  if (provider === "nvidia") {
    if (id === def) return { tag: "agent", note: "codewhip default; ran the tool loop in testing (2026-09-08)" };
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "alibaba") {
    if (id.startsWith("qwen")) {
      return { tag: "untested", note: id === def ? "codewhip default; documented tool-caller, no live probe yet" : "documented tool-caller, no live probe yet" };
    }
    return { tag: "untested", note: "served; agency unknown" };
  }
  if (provider === "sensenova") {
    return { tag: "untested", note: id === def ? "codewhip default; agency unknown (no live probe yet)" : "served; agency unknown" };
  }
  if (provider === "llm7") {
    return { tag: "untested", note: id === def ? "llm7 gateway default; OpenAI-compatible, no live probe yet" : "served via llm7 gateway; agency unknown" };
  }
  if (provider === "tokenharbor") {
    return { tag: "untested", note: id === def ? "tokenharbor orchestrator default; OpenAI-compatible, no live probe yet" : "served via tokenharbor gateway; agency unknown" };
  }
  if (provider === "bai") {
    return { tag: "untested", note: id === def ? "bai gateway default (pricing-table pick; OpenAI-compatible, no live probe yet)" : "served via bai gateway; agency unknown" };
  }
  if (provider === "fabryka") {
    return { tag: "untested", note: id === def ? "fabryka router default (qwen reasoning model; no live probe yet)" : "served via fabryka router; agency unknown" };
  }
  if (provider === "kilo") {
    return { tag: "untested", note: id === def ? "codewhip default; ':free' models anonymous; a tool-call round verified 2026-09-11, no full agent-loop probe" : "served; ':free' models anonymous; listing verified live 2026-09-11; agency unknown" };
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
  unresolvedVars: (baseUrl: string) => string[]
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
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `${provider} models listing timed out after ${MODELS_TIMEOUT_MS}ms` };
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