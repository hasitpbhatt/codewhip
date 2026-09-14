import type { ToolName } from "./tools/types.js";

export type LoopRole = "system" | "user" | "assistant" | "tool";

export type LoopToolCall = {
  id: string;
  name: string;
  argsJson: string;
};

export type LoopMsg = {
  role: LoopRole;
  content: string;
  toolCallId?: string;
  toolCalls?: LoopToolCall[];
};

/** Static OpenAI-style function spec, passed to the provider verbatim. */
export type ToolSpec = {
  name: ToolName;
  description: string;
  parameters: unknown;
};

export type ChatPortResult = {
  text: string | null;
  toolCalls: LoopToolCall[];
  promptTokens: number;
  completionTokens: number;
  /**
   * True when the provider returned no usage block and the numbers are a
   * chars/4 estimate (streaming gateways). Receipts print "est." for these
   * instead of presenting an estimate as a meter reading.
   */
  usageEstimated?: boolean;
};

/**
 * Failure classes the loop acts on. `rate-limited` and `timeout` rotate;
 * `server` (5xx/408) joins them because an upstream 5xx is transient and
 * server-side by definition — it is what a free tier returns under load or in
 * a maintenance window, so treating it as terminal would strand the chain on
 * exactly the failure the chain exists to survive. `auth` and `other` stay
 * terminal: retrying them only repeats the same error.
 */
export type RetryableKind = "rate-limited" | "timeout" | "server" | "auth" | "other";

export type PortFailure = {
  ok: false;
  error: string;
  /** Typed by the adapter from HTTP status — the loop never string-sniffs. */
  retryable: RetryableKind;
  /** Parsed Retry-After, capped at 60s. Absent when not waitable. */
  retryAfterMs?: number;
};

export type ChatPortResponse =
  | ({ ok: true } & ChatPortResult)
  | PortFailure;

/**
 * Narrow provider port. The loop depends ONLY on this — Week-2 adds
 * Anthropic/OpenAI/Ollama adapters behind it without touching loop.ts.
 */
export type ChatPort = (args: {
  model: string;
  messages: LoopMsg[];
  tools: ToolSpec[];
  signal?: AbortSignal;
}) => Promise<ChatPortResponse>;
