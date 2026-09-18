import type {
  ChatPort,
  ChatPortResponse,
  LoopMsg,
  LoopToolCall,
  PortFailure,
  RetryableKind,
  ToolSpec,
} from "./provider-port.js";
import { authHint } from "./provider.js";
import type { ProviderConfig } from "./provider.js";
import { parseRetryAfter, resolveBaseUrl } from "./wire-util.js";
import { recordProviderCall, outcomeForStatus } from "./provider-stats.js";

/**
 * 1min.ai wire adapter.
 *
 * 1min.ai is NOT OpenAI-compatible, so it cannot ride `openAiPort` with a
 * different base URL. Concretely, versus the OpenAI contract:
 *
 *   endpoint   POST /api/chat-with-ai        (no /v1/chat/completions)
 *   auth       `API-KEY: <key>` header       (not `Authorization: Bearer`)
 *   body       {type:"UNIFY_CHAT_WITH_AI", model, promptObject:{prompt}}
 *   messages   NO messages[] — one flattened prompt string
 *   tools      NO tools/tool_choice field at all
 *   sampling   no temperature / max_tokens
 *   response   aiRecord.aiRecordDetail.resultObject (string[])
 *   usage      NO usage block — token counts must be estimated
 *   errors     {success:false, error:{code,message}}
 *
 * Two consequences shape this file:
 *
 * 1. **Tool calls are emulated, not native.** There is no wire-level function
 *    calling, so tool specs are rendered into the prompt and the model is
 *    asked to reply with `<tool_call>{...}</tool_call>` blocks, which we parse
 *    back out. This is best-effort: it depends on the model cooperating. A
 *    model that ignores the instruction degrades to plain text rather than
 *    failing — the loop then sees no tool calls, exactly as if the model had
 *    chosen to answer directly.
 *
 * 2. **Responses are non-streaming.** Streaming would force a named-event SSE
 *    reader (`event: content` / `result` / `done`) *and* make tool extraction
 *    harder, because a `<tool_call>` block can be split across deltas. Whole
 *    bodies keep the parse reliable, so this port ignores `setStreamingEnabled`
 *    entirely. The cost is losing live token output for this one provider.
 *
 * `conversationId` is deliberately never sent: 1min keeps server-side history
 * keyed by that id, and codewhip already sends the full message list on every
 * call. Sending both would double the history.
 */

const MAX_BODY_CHARS = 500;
const TOOL_TAG_RX = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
const FENCE_RX = /```(?:json)?\s*([\s\S]*?)\s*```/g;

/** Response envelope. Everything is optional — we validate before trusting. */
type OneminResponse = {
  success?: unknown;
  error?: { code?: unknown; message?: unknown };
  aiRecord?: {
    status?: unknown;
    model?: unknown;
    aiRecordDetail?: { resultObject?: unknown };
  };
};

/**
 * Render the tool specs into the prompt. Deliberately explicit about the exact
 * block shape: the whole emulation rests on the model emitting something we can
 * parse, so the instruction is stated once and shown by example.
 */
export function renderToolSpecs(tools: ToolSpec[]): string {
  if (tools.length === 0) return "";
  const lines: string[] = [
    "# Tools",
    "You can call tools. To call one, reply with ONLY a block in exactly this form (repeat the block for multiple calls):",
    "",
    '<tool_call>{"name": "search", "arguments": {"query": "foo"}}</tool_call>',
    "",
    "Rules:",
    "- Use only the tool names listed below.",
    "- `arguments` must be a JSON object matching that tool's schema.",
    "- When no tool is needed, reply with plain text and no <tool_call> block.",
    "- Never invent a tool result. The harness returns it in the next message.",
    "",
    "Available tools:",
  ];
  for (const t of tools) {
    lines.push(`### ${t.name}`, t.description, JSON.stringify(t.parameters));
  }
  return lines.join("\n");
}

/**
 * Flatten the loop's message list into 1min's single prompt string. Role labels
 * are load-bearing: with no messages[] array, the labels are the only thing
 * telling the model who said what. Prior assistant tool calls are re-rendered in
 * the same `<tool_call>` shape the model is asked to produce, so its own history
 * reads consistently.
 */
export function flattenMessages(messages: LoopMsg[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "tool") {
      parts.push(`[tool result${m.toolCallId !== undefined && m.toolCallId.length > 0 ? ` ${m.toolCallId}` : ""}]\n${m.content}`);
      continue;
    }
    let block = `[${m.role}]\n${m.content}`;
    for (const call of m.toolCalls ?? []) {
      block += `\n<tool_call>${JSON.stringify({ name: call.name, arguments: parseArgs(call.argsJson) })}</tool_call>`;
    }
    parts.push(block);
  }
  return parts.join("\n\n");
}

/** Tool-call arguments arrive as a JSON string; fall back to {} when unusable. */
function parseArgs(argsJson: string): unknown {
  try {
    return JSON.parse(argsJson) as unknown;
  } catch {
    return {};
  }
}

/** Build the single prompt 1min accepts: tool specs, then the transcript. */
export function buildPrompt(messages: LoopMsg[], tools: ToolSpec[]): string {
  const specs = renderToolSpecs(tools);
  const transcript = flattenMessages(messages);
  return specs.length > 0 ? `${specs}\n\n# Conversation\n${transcript}` : transcript;
}

type ParsedCall = { name: string; argsJson: string };

/** Accept `arguments` as an object or a JSON string; reject anything unusable. */
function toCall(inner: string): ParsedCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inner) as unknown;
  } catch {
    // Repair common model mistakes: trailing commas, extra closing braces
    const repaired = inner
      .replace(/,\s*([}\]])/g, "$1")       // trailing commas
      .replace(/\}\s*\}/g, "}}")           // }} } -> }}
      .replace(/\}\s*\}\s*\}/g, "}}");     // }}} -> }}
    try {
      parsed = JSON.parse(repaired) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as { name?: unknown; arguments?: unknown; args?: unknown };
  const name = typeof obj.name === "string" ? obj.name.trim() : "";
  if (name.length === 0) return null;
  const args = obj.arguments ?? obj.args;
  if (typeof args === "string") {
    return { name, argsJson: args.trim().length > 0 && isJsonObject(args) ? args : "{}" };
  }
  if (typeof args === "object" && args !== null) {
    return { name, argsJson: JSON.stringify(args) };
  }
  return { name, argsJson: "{}" };
}

function isJsonObject(text: string): boolean {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null;
  } catch {
    return false;
  }
}

/**
 * Pull emulated tool calls out of the model's reply. Two tiers: the documented
 * `<tool_call>` tags first, then bare ```json fences as a fallback for models
 * that ignore the tag instruction. Anything that does not parse as a call with
 * a non-empty `name` is left in the text untouched — a fenced code block in a
 * normal answer must not be mistaken for a tool call.
 */
export function parseEmulatedToolCalls(raw: string): { text: string; toolCalls: LoopToolCall[] } {
  const found: ParsedCall[] = [];
  let text = raw;
  const consume = (rx: RegExp): void => {
    text = text.replace(rx, (whole: string, inner: string) => {
      const call = toCall(inner);
      if (call === null) return whole;
      found.push(call);
      return "";
    });
  };
  consume(TOOL_TAG_RX);
  if (found.length === 0) consume(FENCE_RX);
  const toolCalls: LoopToolCall[] = found.map((c, i) => ({ id: `call_${i}`, name: c.name, argsJson: c.argsJson }));
  return { text: text.trim(), toolCalls };
}

/** Join 1min's `resultObject` string array into one reply. */
export function unwrapResult(data: OneminResponse): { text: string; status: string } {
  const status = typeof data.aiRecord?.status === "string" ? data.aiRecord.status : "";
  const raw = data.aiRecord?.aiRecordDetail?.resultObject;
  const parts = Array.isArray(raw) ? raw.filter((r): r is string => typeof r === "string") : [];
  return { text: parts.join("\n").trim(), status };
}

/** `error.code`/`error.message` when the envelope has them, else the fallback. */
function errorDetail(body: string, fallback: string): string {
  try {
    const parsed = JSON.parse(body) as OneminResponse;
    const code = typeof parsed.error?.code === "string" ? parsed.error.code : "";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
    const joined = [code, message].filter((s) => s.length > 0).join(": ");
    return joined.length > 0 ? joined : fallback;
  } catch {
    return fallback;
  }
}

function hintFor(cfg: ProviderConfig, status: number, body: string, keySource?: string): string {
  const detail = errorDetail(body, body);
  if (status === 401 || status === 403) {
    return authHint(cfg, keySource);
  }
  if (status === 402) {
    return `${cfg.brand} needs credits for this call — top up your plan (${cfg.keyUrl})`;
  }
  if (status === 429) {
    return `rate limited on ${cfg.brand}${cfg.rateLimitedHint !== undefined ? ` — ${cfg.rateLimitedHint}` : ""}`;
  }
  if (status === 404 || status === 410) {
    return `unknown or retired model on ${cfg.brand}. ${detail}`;
  }
  return `${cfg.brand} api error ${status}. ${detail}`;
}

/** chars/4 fallback: 1min returns no usage block, so every count here is an estimate. */
function estimate(promptChars: number, replyChars: number): { prompt: number; completion: number } {
  return { prompt: Math.ceil(promptChars / 4), completion: Math.ceil(replyChars / 4) };
}

export function oneminPort(cfg: ProviderConfig, apiKey: string, timeoutMs?: number, keySource?: string): ChatPort {
  const brand = cfg.brand;
  const limit = timeoutMs ?? cfg.timeoutMs;
  const url = `${resolveBaseUrl(cfg.baseUrl)}${cfg.chatPath}`;
  return async ({ model, messages, tools, signal }): Promise<ChatPortResponse> => {
    if (apiKey.length === 0) {
      return { ok: false, error: "missing api key", retryable: "other" };
    }
    if (model.length === 0 || model.length > 200) {
      return { ok: false, error: "bad model id (empty or >200 chars)", retryable: "other" };
    }
    const ctrl = new AbortController();
    // Classified by these flags, never by the rejection's `name` — see openAiPort.
    let timedOut = false;
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
    const onAbort = (): void => ctrl.abort(signal?.reason);
    try {
      if (signal !== undefined) {
        if (signal.aborted) {
          return { ok: false, error: "cancelled", retryable: "other" };
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const prompt = buildPrompt(messages, tools);
      const body = JSON.stringify({ type: "UNIFY_CHAT_WITH_AI", model, promptObject: { prompt } });
      const headers: Record<string, string> = {
        // The chat endpoint documents `API-KEY`; the intro page claims
        // `Authorization: Bearer`. They contradict, so send both — an extra
        // auth header is ignored far more often than it is rejected, and this
        // is the difference between working first try and not at all.
        "API-KEY": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      };
      const callStart = Date.now();
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", headers, body, signal: ctrl.signal });
      } catch (err) {
        if (signal?.aborted === true) {
          return { ok: false, error: "cancelled", retryable: "other" };
        }
        const name = err instanceof Error ? err.name : "";
        if (timedOut || name === "TimeoutError" || name === "AbortError") {
          recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "timeout", host: cfg.baseUrl, ms: Date.now() - callStart });
          return { ok: false, error: `${brand} api timed out after ${limit}ms`, retryable: "timeout" };
        }
        const netErr = `network error: ${err instanceof Error ? err.message : "fetch failed"}`;
        recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "network", host: cfg.baseUrl, ms: Date.now() - callStart, error: netErr.slice(0, 120) });
        return { ok: false, error: netErr, retryable: "other" };
      }
      const ms = Date.now() - callStart;
      if (!res.ok) {
        let respBody = "";
        try {
          respBody = (await res.text()).slice(0, MAX_BODY_CHARS);
        } catch {
          respBody = "";
        }
        // 5xx/408 are transient server-side conditions and join the rotation
        // path (see RetryableKind) — a 4xx here means the request itself is
        // wrong, so it stays terminal.
        const retryable: RetryableKind =
          res.status === 429
            ? "rate-limited"
            : res.status === 401 || res.status === 403
              ? "auth"
              : res.status >= 500 || res.status === 408
                ? "server"
                : "other";
        const failure: PortFailure = { ok: false, error: hintFor(cfg, res.status, respBody, keySource), retryable };
        if (retryable === "rate-limited") {
          const wait = parseRetryAfter(res.headers.get("retry-after"));
          if (wait !== undefined) {
            failure.retryAfterMs = wait;
          }
        }
        recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: outcomeForStatus(res.status), host: cfg.baseUrl, status: res.status, ms, error: respBody.slice(0, 120) });
        return failure;
      }
      let data: OneminResponse;
      try {
        data = (await res.json()) as OneminResponse;
      } catch {
        return { ok: false, error: `${brand} api returned invalid JSON`, retryable: "other" };
      }
      if (data.success === false) {
        const detail = errorDetail(JSON.stringify(data), "request rejected");
        recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "other", host: cfg.baseUrl, status: res.status, ms, error: detail.slice(0, 120) });
        return { ok: false, error: `${brand} rejected the request — ${detail}`, retryable: "other" };
      }
      const { text, status } = unwrapResult(data);
      if (status.length > 0 && status !== "SUCCESS") {
        recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "other", host: cfg.baseUrl, status: res.status, ms, error: `record ${status}` });
        return { ok: false, error: `${brand} record ended ${status}`, retryable: "other" };
      }
      if (text.length === 0) {
        return { ok: false, error: `${brand} api returned no text`, retryable: "other" };
      }
      const parsed = parseEmulatedToolCalls(text);
      if (parsed.text.length === 0 && parsed.toolCalls.length === 0) {
        return { ok: false, error: `${brand} api returned no text or tool calls`, retryable: "other" };
      }
      recordProviderCall({ ts: new Date().toISOString(), provider: cfg.id, model, kind: "chat", outcome: "ok", host: cfg.baseUrl, status: res.status, ms });
      const usage = estimate(prompt.length, text.length);
      return {
        ok: true,
        text: parsed.text.length > 0 ? parsed.text : null,
        toolCalls: parsed.toolCalls,
        promptTokens: usage.prompt,
        completionTokens: usage.completion,
        // Always true: 1min exposes no usage block, so every number here is
        // chars/4. Receipts print "est." rather than passing an estimate off
        // as a meter reading.
        usageEstimated: true,
      };
    } finally {
      clearTimer();
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
