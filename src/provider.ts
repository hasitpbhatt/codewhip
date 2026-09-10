import type {
  ChatPort,
  ChatPortResponse,
  LoopMsg,
  LoopToolCall,
  PortFailure,
  RetryableKind,
} from "./provider-port.js";

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com";
export const NVIDIA_DEFAULT_MODEL = "moonshotai/kimi-k3";
export const MISTRAL_BASE_URL = "https://api.mistral.ai";
export const MISTRAL_DEFAULT_MODEL = "codestral-latest";
const NVIDIA_TIMEOUT_MS = 45000;
const MISTRAL_TIMEOUT_MS = 45000;
const MAX_BODY_CHARS = 500;

export type ChatRole = "system" | "user";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type ProviderSuccess = {
  ok: true;
  text: string;
  promptTokens: number;
  completionTokens: number;
  model: string;
};

export type ProviderFailure = {
  ok: false;
  error: string;
};

export type ProviderResult = ProviderSuccess | ProviderFailure;

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

function statusHint(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "invalid or missing NVIDIA_API_KEY (get one at https://build.nvidia.com/settings/api-keys)";
  }
  if (status === 404 || status === 410) {
    return `unknown or retired model (list live ones via GET ${NVIDIA_BASE_URL}/v1/models). ${body}`;
  }
  if (status === 429) {
    return "rate limited (free tier ~40 req/min) — wait and retry";
  }
  return `nvidia api error ${status}. ${body}`;
}

export async function chatNvidia(args: {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  timeoutMs?: number;
}): Promise<ProviderResult> {
  if (args.apiKey.length === 0) {
    return { ok: false, error: "missing api key" };
  }
  if (args.model.length === 0 || args.model.length > 200) {
    return { ok: false, error: "bad model id (empty or >200 chars)" };
  }
  if (args.messages.length === 0) {
    return { ok: false, error: "no messages to send" };
  }
  const maxTokens = args.maxTokens ?? 1024;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) {
    return { ok: false, error: "maxTokens must be an integer 1..8192" };
  }
  let res: Response;
  try {
    res = await fetch(`${NVIDIA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: args.model,
        messages: args.messages,
        max_tokens: maxTokens,
        stream: false,
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? NVIDIA_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, error: `nvidia api timed out after ${args.timeoutMs ?? NVIDIA_TIMEOUT_MS}ms` };
    }
    return { ok: false, error: `network error: ${err instanceof Error ? err.message : "fetch failed"}` };
  }
  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, MAX_BODY_CHARS);
    } catch {
      body = "";
    }
    return { ok: false, error: statusHint(res.status, body) };
  }
  let data: NvidiaChatResponse;
  try {
    data = (await res.json()) as NvidiaChatResponse;
  } catch {
    return { ok: false, error: "nvidia api returned invalid JSON" };
  }
  const first = Array.isArray(data.choices) ? data.choices[0] : undefined;
  const content = first?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    return { ok: false, error: "nvidia api returned no text" };
  }
  return {
    ok: true,
    text: content,
    promptTokens: toCount(data.usage?.prompt_tokens),
    completionTokens: toCount(data.usage?.completion_tokens),
    model: args.model,
  };
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

function mistralStatusHint(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return "invalid MISTRAL_API_KEY (create one at console.mistral.ai)";
  }
  if (status === 404 || status === 410) {
    return `unknown or retired mistral model. ${body}`;
  }
  if (status === 429) {
    return "mistral rate limited (free mode caps RPS + tokens/min + tokens/month — see Limits in console.mistral.ai)";
  }
  return `mistral api error ${status}. ${body}`;
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

function openAiPort(args: {
  baseUrl: string;
  brand: string;
  apiKey: string;
  hint: (status: number, body: string) => string;
  timeoutMs: number;
}): ChatPort {
  const { baseUrl, brand, apiKey, hint, timeoutMs: limit } = args;
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
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
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
        return { ok: false, error: `${brand} api timed out after ${limit}ms`, retryable: "other" };
      }
      return { ok: false, error: `network error: ${err instanceof Error ? err.message : "fetch failed"}`, retryable: "other" };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

/** Tool-calling adapter implementing the loop's ChatPort over NVIDIA. */
export function makeNvidiaPort(apiKey: string, timeoutMs?: number): ChatPort {
  return openAiPort({
    baseUrl: NVIDIA_BASE_URL,
    brand: "nvidia",
    apiKey,
    hint: statusHint,
    timeoutMs: timeoutMs ?? NVIDIA_TIMEOUT_MS,
  });
}

/** Mistral adapter implementing the loop's ChatPort (OpenAI-compatible). */
export function makeMistralPort(apiKey: string, timeoutMs?: number): ChatPort {
  return openAiPort({
    baseUrl: MISTRAL_BASE_URL,
    brand: "mistral",
    apiKey,
    hint: mistralStatusHint,
    timeoutMs: timeoutMs ?? MISTRAL_TIMEOUT_MS,
  });
}
