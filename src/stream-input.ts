import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

/**
 * The inbound half of headless scripting: `--input-format stream-json`.
 *
 * stdin becomes a stream of NDJSON user messages instead of one blob of text,
 * so a script can drive several turns over one process (and one session file)
 * without a REPL. The shape accepted is exactly one shape —
 * `{"type":"user","message":{"role":"user","content": … }}` — and every other
 * line is refused by name rather than skipped: a control stream that quietly
 * drops the message it did not understand is worse than one that stops.
 *
 * What is deliberately NOT here: feeding a `tool_result` back in, or answering
 * a permission prompt from the pipe (`control_request`/`control_response`).
 * Both need an inbound path into a *running* step, and this harness reads
 * input only at turn boundaries — claiming the flag otherwise would advertise
 * mid-run steering it does not have.
 */

export const INPUT_FORMATS = ["text", "stream-json"] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

export function parseInputFormat(raw: string): InputFormat | null {
  return (INPUT_FORMATS as readonly string[]).includes(raw) ? raw as InputFormat : null;
}

/** One message is a line; a line this long is a mistake, not a prompt. */
export const MAX_MESSAGE_CHARS = 262_144;

/** Bound a runaway producer: more turns than this means the loop is upstream. */
export const MAX_MESSAGES = 64;

export type InboundMessage = { ok: true; text: string } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Parse one NDJSON line into the text of a user turn.
 *
 * `role: "assistant"` is refused on purpose: inbound text is operator
 * material, and letting the pipe assert what the model already said would
 * rewrite the agent's own history from outside the loop.
 */
export function parseUserMessage(line: string): InboundMessage {
  const trimmed = line.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty line — expected one JSON object per line" };
  if (trimmed.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message is ${trimmed.length} chars, over the ${MAX_MESSAGE_CHARS} cap` };
  }
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `line is not JSON: ${why}` };
  }
  if (!isRecord(value)) return { ok: false, error: "line must be a JSON object" };
  const type = value["type"];
  if (type !== "user") {
    return {
      ok: false,
      error: `type ${JSON.stringify(type)} is not accepted — only {"type":"user",…} messages are read; a tool_result or control_response has no inbound path at a turn boundary`,
    };
  }
  const message = value["message"];
  if (!isRecord(message)) return { ok: false, error: `message must be an object (got ${JSON.stringify(message)})` };
  const role = message["role"];
  if (role !== "user") {
    return { ok: false, error: `message.role ${JSON.stringify(role)} is refused — inbound text is operator material, not a replayed model turn` };
  }
  const content = message["content"];
  if (typeof content === "string") {
    const text = content.trim();
    return text.length === 0 ? { ok: false, error: "message.content is empty" } : { ok: true, text };
  }
  if (!Array.isArray(content) || content.length === 0) {
    return { ok: false, error: "message.content must be a non-empty string or an array of text blocks" };
  }
  const parts: string[] = [];
  for (const [i, block] of content.entries()) {
    if (!isRecord(block)) return { ok: false, error: `message.content/${i} must be an object` };
    if (block["type"] !== "text") {
      return { ok: false, error: `message.content/${i} is a ${JSON.stringify(block["type"])} block — only text blocks are read (vision input is a separate parity row)` };
    }
    if (typeof block["text"] !== "string") return { ok: false, error: `message.content/${i}.text must be a string` };
    parts.push(block["text"]);
  }
  const text = parts.join("\n").trim();
  return text.length === 0 ? { ok: false, error: "message.content carries no text" } : { ok: true, text };
}

/**
 * Read stdin as NDJSON user messages, yielding one parsed result per line.
 *
 * Parsing stops at the first refusal — the caller decides what a broken control
 * stream means, and every reason is a value rather than a throw so a driver
 * can finish the turn already in flight before it reports.
 */
export async function* inboundMessages(stream: Readable): AsyncGenerator<InboundMessage> {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of rl) {
      if (line.trim().length === 0) continue;
      const parsed = parseUserMessage(line);
      if (!parsed.ok) {
        yield parsed;
        return;
      }
      seen += 1;
      if (seen > MAX_MESSAGES) {
        yield { ok: false, error: `input carries more than ${MAX_MESSAGES} messages — run the rest as a separate invocation` };
        return;
      }
      yield parsed;
    }
  } finally {
    rl.close();
  }
}
