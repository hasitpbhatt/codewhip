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
};

export type ChatPortResponse =
  | ({ ok: true } & ChatPortResult)
  | { ok: false; error: string };

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
