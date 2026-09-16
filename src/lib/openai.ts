/**
 * OpenAI Protocol Conversion for CodeWhip Proxy
 * 
 * Converts between OpenAI API format and CodeWhip's internal message format.
 * These functions are pure and have no external dependencies.
 */

import type { LoopMsg, LoopToolCall, ToolSpec } from "./types.js";

// ============================================================================
// OpenAI Messages → CodeWhip Messages
// ============================================================================

/**
 * Convert OpenAI `tools[]` to CodeWhip's `ToolSpec[]`.
 * Names pass through verbatim.
 */
export function toToolSpecs(raw: unknown): ToolSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolSpec[] = [];
  for (const entry of raw) {
    const fn = (entry as { function?: { name?: unknown; description?: unknown; parameters?: unknown } })?.function;
    const name = typeof fn?.name === "string" ? fn.name.trim() : "";
    if (name.length === 0) continue;
    out.push({
      name: name as ToolSpec["name"],
      description: typeof fn?.description === "string" ? fn.description : "",
      parameters: (fn?.parameters as Record<string, unknown>) ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/**
 * Convert OpenAI tool calls to CodeWhip's internal format.
 */
export function toLoopToolCalls(raw: unknown): LoopToolCall[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopToolCall[] = [];
  for (const entry of raw) {
    const c = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    const name = typeof c?.function?.name === "string" ? c.function.name : "";
    if (name.length === 0) continue;
    const args = c.function?.arguments;
    out.push({
      id: typeof c.id === "string" && c.id.length > 0 ? c.id : `call_${out.length}`,
      name,
      argsJson: typeof args === "string" && args.length > 0 ? args : "{}",
    });
  }
  return out;
}

/**
 * Convert OpenAI content parts to plain text.
 */
export function contentToText(content: unknown[]): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { text: string } =>
      typeof part === "object" &&
      part !== null &&
      "text" in part &&
      typeof (part as any).text === "string"
    )
    .map((p) => p.text)
    .join("");
}

/**
 * Convert OpenAI `messages[]` to CodeWhip's `LoopMsg[]`.
 * Non-string content is flattened.
 */
export function toLoopMessages(raw: unknown): LoopMsg[] {
  if (!Array.isArray(raw)) return [];
  const out: LoopMsg[] = [];
  for (const entry of raw) {
    const m = entry as { role?: unknown; content?: unknown; tool_calls?: unknown; tool_call_id?: unknown };
    const role = m?.role;
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? contentToText(m.content) : "";
    if (role === "tool") {
      out.push({
        role: "tool",
        content,
        toolCallId: typeof m.tool_call_id === "string" ? m.tool_call_id : undefined,
      });
      continue;
    }
    if (role === "assistant") {
      const toolCalls = toLoopToolCalls(m.tool_calls);
      out.push(toolCalls.length > 0 ? { role, content, toolCalls } : { role, content });
      continue;
    }
    out.push({ role, content });
  }
  return out;
}

// ============================================================================
// CodeWhip Messages → OpenAI Format
// ============================================================================

/**
 * Create a single `choices[0]` entry in OpenAI's non-streaming shape.
 */
export function completionChoice(
  text: string | null,
  toolCalls: LoopToolCall[]
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: "assistant", content: text };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls.map((c, i) => ({
      index: i,
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: c.argsJson },
    }));
  }
  return {
    index: 0,
    message,
    finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop",
  };
}

// ============================================================================
// Route Resolution
// ============================================================================

/**
 * Map an HTTP status to a coarse error category.
 */
export function statusForError(error: string | undefined): number {
  if (error === "auth") return 401;
  if (error === "rate-limited") return 429;
  if (error === "timeout") return 504;
  if (error === "server") return 502;
  return 502;
}

/**
 * Resolve the `model` field from an incoming OpenAI request into a target provider and model.
 * 
 * - `provider:model` wins (split at the FIRST colon)
 * - a bare provider id means "that provider's default model"
 * - anything else is a model id on the server's default provider
 * - `auto` calls the auto-selection logic
 * - empty falls back to server defaults
 */
export function resolveTarget(
  requested: string,
  fallback: { provider: string; model: string }
): { provider: string; model: string } | { error: string } {
  const trimmed = requested.trim();
  if (trimmed.length === 0) {
    return fallback;
  }

  // Handle "auto" selection
  if (trimmed === "auto") {
    return { provider: fallback.provider, model: fallback.model };
  }

  // Handle provider:model format
  const colon = trimmed.indexOf(":");
  if (colon > 0) {
    const provider = trimmed.slice(0, colon);
    const model = trimmed.slice(colon + 1);
    if (model.length === 0) {
      return { error: `missing model id after "${provider}:"` };
    }
    return { provider, model };
  }

  // Handle bare provider name (use default model)
  return { provider: trimmed, model: fallback.model };
}