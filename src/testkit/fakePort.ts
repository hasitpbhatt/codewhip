import type { ChatPort, ChatPortResponse, LoopMsg } from "../provider-port.js";

/**
 * Scripted ChatPort for $0-quota tests. Each call consumes the next
 * response in `responses` (clamped to the last). `record` accumulates
 * every call's model and tool count so tests can assert routing.
 */
export function makeFakePort(
  responses: ChatPortResponse[],
  opts?: { strict?: boolean }
): {
  port: ChatPort;
  record: Array<{ model: string; toolCount: number }>;
  messagesSeen: LoopMsg[][];
} {
  let i = 0;
  const record: Array<{ model: string; toolCount: number }> = [];
  const messagesSeen: LoopMsg[][] = [];
  const port: ChatPort = async (args) => {
    record.push({ model: args.model, toolCount: args.tools.length });
    messagesSeen.push(args.messages);
    // Default replays the last response (lenient); strict mode throws on
    // over-consume so a regression that doubles provider calls fails the
    // test instead of silently passing on the final scripted turn.
    if (i >= responses.length) {
      if (opts?.strict === true) {
        throw new Error(`fakePort: over-consumed (${record.length} calls > ${responses.length} responses)`);
      }
      return responses[responses.length - 1] as ChatPortResponse;
    }
    return responses[i++] as ChatPortResponse;
  };
  return { port, record, messagesSeen };
}

/** Shorthand: a plain-text turn. */
export function textTurn(text: string, tokens?: { prompt: number; completion: number }): ChatPortResponse {
  return { ok: true, text, toolCalls: [], promptTokens: tokens?.prompt ?? 1, completionTokens: tokens?.completion ?? 1 };
}
/** Shorthand: a tool-call turn. */
export function toolTurn(
  name: string,
  argsJson: string,
  tokens?: { prompt: number; completion: number },
): ChatPortResponse {
  return {
    ok: true, text: null, toolCalls: [{ id: `call-${name}`, name, argsJson }],
    promptTokens: tokens?.prompt ?? 1, completionTokens: tokens?.completion ?? 1,
  };
}
/** Shorthand: one assistant turn requesting several tools at once. */
export function toolBatchTurn(
  calls: ReadonlyArray<{ id: string; name: string; argsJson: string }>,
  tokens?: { prompt: number; completion: number },
): ChatPortResponse {
  return {
    ok: true, text: null, toolCalls: calls.map((c) => ({ ...c })),
    promptTokens: tokens?.prompt ?? 1, completionTokens: tokens?.completion ?? 1,
  };
}

/** Shorthand: a 429 with optional Retry-After seconds. */
export function rateLimited(retryAfterMs?: number): ChatPortResponse {
  return { ok: false, error: "rate limited", retryable: "rate-limited", retryAfterMs };
}
/** Shorthand: a provider-side timeout (joins the rotation path, never retry-wait). */
export function timeoutFailure(): ChatPortResponse {
  return { ok: false, error: "test api timed out after 120000ms", retryable: "timeout" };
}
/** Shorthand: an auth failure. */
export function authFailure(): ChatPortResponse {
  return { ok: false, error: "invalid key", retryable: "auth" };
}
/** Shorthand: an upstream 5xx — joins the rotation path, like a timeout. */
export function serverFailure(status = 503): ChatPortResponse {
  return { ok: false, error: `test api error ${status}. upstream maintenance`, retryable: "server" };
}
/** Shorthand: a non-retryable failure. */
export function otherFailure(): ChatPortResponse {
  return { ok: false, error: "something else", retryable: "other" };
}
