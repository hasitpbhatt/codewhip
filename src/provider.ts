import type {
  ChatPort,
  ChatPortResponse,
  LoopMsg,
  LoopToolCall,
  PortFailure,
  RetryableKind,
} from "./provider-port.js";

/**
 * Builtin provider registry — adding a builtin is ONE table row, nothing else.
 * User-registered providers live outside this file (see custom-providers.ts:
 * `codewhip provider add`) and ride the same OpenAI-compatible ChatPort.
 * The loop only ever sees a ChatPort; openAiPort adapts any config.
 */

/** Builtins shipped with the install (llm7/tokenharbor/bai/fabryka: gateway tiers; the rest: free aggregators). */
export type BuiltinProviderId = "nvidia" | "mistral" | "sensenova" | "alibaba" | "llm7" | "tokenharbor" | "bai" | "fabryka" | "opencode" | "kilo" | "groq" | "cerebras" | "openrouter" | "gemini" | "zai" | "empero";

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
};

/**
 * Single default for every builtin chat call. One place on purpose: eight
 * identical per-provider constants already diverged once (45s -> 120s), and
 * per-provider tuning belongs in the row below, not in a constant farm.
 * Custom providers carry their own timeoutMs (default in custom-providers.ts).
 */
export const DEFAULT_CHAT_TIMEOUT_MS = 120000;
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

function openAiPort(cfg: ProviderConfig, apiKey: string, timeoutMs?: number): ChatPort {
  const baseUrl = chatUrlFor(cfg);
  const brand = cfg.brand;
  const hint = genericHint(cfg);
  const limit = timeoutMs ?? cfg.timeoutMs;
  return async ({ model, messages, tools, signal }): Promise<ChatPortResponse> => {
    if (apiKey.length === 0) {
      return { ok: false, error: "missing api key", retryable: "other" };
    }
    if (model.length === 0 || model.length > 200) {
      return { ok: false, error: "bad model id (empty or >200 chars)", retryable: "other" };
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error("timeout")), limit);
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
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: wireHeaders,
        body: JSON.stringify({
          model,
          messages: toWireMessages(messages),
          tools: tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
          stream: false,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        let body = "";
        try {
          body = (await res.text()).slice(0, MAX_BODY_CHARS);
        } catch {
          body = "";
        }
        return httpFailure(res.status, body, hint, res);
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
      return {
        ok: true,
        text: content,
        toolCalls,
        promptTokens: toCount(data.usage?.prompt_tokens),
        completionTokens: toCount(data.usage?.completion_tokens),
      };
    } catch (err) {
      if (signal !== undefined && signal.aborted) {
        return { ok: false, error: "cancelled", retryable: "other" };
      }
      const name = err instanceof Error ? err.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        return { ok: false, error: `${brand} api timed out after ${limit}ms`, retryable: "timeout" };
      }
      return { ok: false, error: `network error: ${err instanceof Error ? err.message : "fetch failed"}`, retryable: "other" };
    } finally {
      clearTimeout(timer);
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