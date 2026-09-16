/**
 * Core Types for CodeWhip Proxy Library
 * 
 * These are platform-agnostic and can be used in both Node.js and Cloudflare Workers.
 */

export type ProviderId = string;

export interface ProviderConfig {
  id: string;
  brand: string;
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  defaultModel: string;
  envVar: string;
  keyUrl: string;
  timeoutMs: number;
  anonymousKey?: string;
  headers?: Record<string, string>;
  rateLimitedHint?: string;
  port?: string;
}

export interface Target {
  provider: ProviderId;
  model: string;
}

export interface ServeOptions {
  /** Provider used when the requested model has no `provider:` prefix. */
  provider: ProviderId;
  /** Model used when the request names none. */
  model: string;
  /** When set, requests must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Serve the provider key manager UI (HTML + JSON API); off by default. */
  authUi?: boolean;
  /** When true, /v1/models only lists providers that respond to their models endpoint. */
  pingModels?: boolean;
  /** Storage backend for keys and provider configs. */
  storage: Storage;
}

export interface OpenAiMessage {
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

export interface OpenAiRequest {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
  stream?: unknown;
  stream_options?: unknown;
}

export type KeySource = "env" | "file" | "anonymous" | "none";

export interface Storage {
  /**
   * Resolve a provider key. Priority: env var → stored file → anonymous key → none.
   */
  resolveKey(provider: ProviderId): Promise<{ key: string; source: KeySource }>;

  /**
   * List all provider configurations (builtin + custom).
   */
  listAllProviderConfigs(): Promise<ProviderConfig[]>;

  /**
   * Get a specific provider configuration.
   */
  getProviderConfig(provider: ProviderId): Promise<ProviderConfig | null>;
}

export interface LoopMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: LoopToolCall[];
}

export interface LoopToolCall {
  id: string;
  name: string;
  argsJson: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatPortResponse {
  ok: boolean;
  text: string | null;
  toolCalls: LoopToolCall[];
  promptTokens: number;
  completionTokens: number;
  usageEstimated: boolean;
  error?: string;
  retryable?: string;
}

export type ChatPort = (args: {
  model: string;
  messages: LoopMsg[];
  tools?: ToolSpec[];
}) => Promise<ChatPortResponse>;