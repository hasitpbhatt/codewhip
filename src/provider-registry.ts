/**
 * Provider registry types — pure data, zero imports.
 *
 * There are no builtin providers. Every provider is user-registered with
 * `codewhip provider add <id> --base-url <https origin> --env-var <VAR>`:
 * a custom base URL and the bearer token it needs. Registry data lives in
 * src/provider-registry.ts (a zero-import data leaf) so wire/auth machinery
 * in provider.ts stays separate from the type surface.
 */

import type { ProviderId as ProviderIdFromPort } from "./provider-port.js";

/** Builtins shipped with the install. There are none: every provider is custom. */
export type BuiltinProviderId = never;

/** Any provider id: a user-registered custom id. */
export type ProviderId = ProviderIdFromPort;

export const PROVIDER_IDS: readonly BuiltinProviderId[] = [];

export function isBuiltinProviderId(_value: string): _value is BuiltinProviderId {
  return false;
}

/**
 * Which wire adapter serves a row. `"openai"` is the only kind left: every
 * custom provider is OpenAI-compatible (a custom base URL plus a bearer
 * token). The `onemin` port (src/onemin.ts) went out with its builtin row.
 */
export type PortKind = "openai";

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
  /** Optional placeholder for keyless/local providers (e.g. "local" for loopback). */
  anonymousKey?: string;
  /** If true, the provider is hidden from catalogs and not routable. */
  disabled?: boolean;
  /** Per-provider static headers merged into every chat/models call. */
  headers?: Record<string, string>;
  /** Extra base URLs to try (in order) when `baseUrl` auths with 401/403. */
  fallbackBaseUrls?: string[];
  /** Wire adapter for this row. Omitted means "openai". */
  port?: PortKind;
  /**
   * Context window (tokens) of this row's DEFAULT model, set ONLY when
   * verified. The run's compaction ceiling derives from it (0.7x). Never
   * fiction: an unverified window stays undefined and keeps the default 60k
   * ceiling.
   */
  contextWindow?: number;
};

/**
 * Single default for a chat call when a row carries none. Per-provider tuning
 * belongs in the row, not a constant farm; custom providers carry their own
 * timeoutMs (default in custom-providers.ts).
 */
export const DEFAULT_CHAT_TIMEOUT_MS = 120000;
/**
 * Bounds for any per-call chat budget. The ceiling deliberately exceeds the
 * default: slow endpoints routinely need 60-100s per call, so a cap equal to
 * the default left no way to buy headroom without re-registering the provider.
 */
export const MIN_CHAT_TIMEOUT_MS = 5000;
export const MAX_CHAT_TIMEOUT_MS = 600000;

/** Empty: there are no builtin provider rows. */
export const PROVIDERS: Record<string, never> = {};
