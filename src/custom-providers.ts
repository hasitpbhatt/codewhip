import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";
import { lockFileOwnerOnly } from "./secure-file.js";
import { allowedModelsFor, disableEntries, enableEntries } from "./model-allowlist.js";
import { isBuiltinProviderId, MAX_CHAT_TIMEOUT_MS, MIN_CHAT_TIMEOUT_MS, PROVIDERS, type ProviderConfig } from "./provider.js";

/**
 * User-registered OpenAI-compatible providers (`codewhip provider add`).
 * Stored as `{ providers: ProviderConfig[] }` in the global config dir
 * (next to credentials.json — no secrets here, keys stay in
 * credentials.json / env). Never throws; corrupt files read as empty.
 */

export const CUSTOM_PROVIDERS_FILE = "custom-providers.json";
const DEFAULT_CHAT_PATH = "/v1/chat/completions";
const DEFAULT_MODELS_PATH = "/v1/models";
const DEFAULT_TIMEOUT_MS = 45000;

const ID_RX = /^[a-z0-9][a-z0-9-]{1,31}$/;
const ENV_RX = /^[A-Z][A-Z0-9_]{2,63}$/;

/**
 * Loopback hosts, in the forms `new URL().hostname` actually yields — IPv6
 * literals keep their brackets, so "[::1]" is matched as well as "::1". The
 * whole 127.0.0.0/8 block is loopback per RFC 1122, not just 127.0.0.1.
 */
const LOOPBACK_RX = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|\[::1\])$/i;

/**
 * Is this a local runtime's base URL? Plain `http://` is accepted ONLY here.
 *
 * Local runtimes (Ollama :11434, vLLM :8000, LM Studio :1234) speak http, and
 * loopback is the one case where the traffic provably cannot leave the machine
 * — which is exactly what the router's `private` class needs behind it. Any
 * other host over `http://` would put the provider key on the wire in clear
 * text, so it stays refused.
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return u.protocol === "http:" && LOOPBACK_RX.test(u.hostname);
  } catch {
    return false;
  }
}

/** https anywhere, or http on loopback only. Length/whitespace are checked first. */
function isAllowedBaseUrl(baseUrl: string): boolean {
  if (baseUrl.length > 200 || /\s/.test(baseUrl)) return false;
  return baseUrl.startsWith("https://") || isLoopbackBaseUrl(baseUrl);
}

export type CustomProviderInput = {
  id: string;
  baseUrl: string;
  defaultModel: string;
  envVar: string;
  brand?: string;
  chatPath?: string;
  modelsPath?: string;
  keyUrl?: string;
  timeoutMs?: number;
  rateLimitedHint?: string;
};

export function customProvidersPath(dir?: string): string {
  return path.join(dir ?? configDir(), CUSTOM_PROVIDERS_FILE);
}

function normalize(input: CustomProviderInput): ProviderConfig | { error: string } {
  const id = input.id.trim().toLowerCase();
  if (!ID_RX.test(id)) return { error: `bad id "${input.id}" (lowercase letters/digits/dashes, 2..32 chars)` };
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (isBuiltinProviderId(id)) {
    const builtin = PROVIDERS[id];
    // The obvious id for a local runtime ("ollama") is usually already owned by
    // a *remote* builtin of the same name. Saying "no registration needed" there
    // is actively misleading — the builtin is the cloud service, not your box.
    if (isLoopbackBaseUrl(baseUrl)) {
      return {
        error: `"${id}" is the remote ${builtin.brand} builtin (${builtin.baseUrl}) — use a distinct id for a local runtime, e.g. "${id}-local"`,
      };
    }
    return { error: `"${id}" is a builtin provider — no registration needed` };
  }
  if (!isAllowedBaseUrl(baseUrl)) {
    return { error: "bad --base-url (need https://origin — or http:// on loopback for a local runtime; no trailing slash)" };
  }
  const defaultModel = input.defaultModel.trim();
  if (defaultModel.length === 0 || defaultModel.length > 200) return { error: "bad --model (need 1..200 chars)" };
  const envVar = input.envVar.trim();
  if (!ENV_RX.test(envVar)) return { error: `bad --env-var "${input.envVar}" (need UPPER_SNAKE like MYFOO_API_KEY)` };
  const chatPath = (input.chatPath ?? DEFAULT_CHAT_PATH).trim() || DEFAULT_CHAT_PATH;
  const modelsPath = (input.modelsPath ?? DEFAULT_MODELS_PATH).trim() || DEFAULT_MODELS_PATH;
  if (!chatPath.startsWith("/") || !modelsPath.startsWith("/")) {
    return { error: "bad paths (--chat-path/--models-path must start with /)" };
  }
  const keyUrl = (input.keyUrl ?? "").trim();
  if (keyUrl.length > 0 && (!keyUrl.startsWith("https://") || /\s/.test(keyUrl))) {
    return { error: "bad --key-url (need https://… or omit)" };
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_CHAT_TIMEOUT_MS || timeoutMs > MAX_CHAT_TIMEOUT_MS) {
    return { error: `bad --timeout-ms (need integer ${MIN_CHAT_TIMEOUT_MS}..${MAX_CHAT_TIMEOUT_MS})` };
  }
  const brand = (input.brand ?? id).trim() || id;
  const cfg: ProviderConfig = { id, brand, baseUrl, chatPath, modelsPath, defaultModel, envVar, keyUrl, timeoutMs };
  // A local runtime needs no credential, but every call path refuses an empty
  // key (index.ts:597, serve.ts:342) — so a keyless local provider would
  // resolve and then abort. Registering the placeholder is what makes the
  // zero-config promise true. env/file still win, so a secured runtime that
  // does want a token is unaffected, and nothing is billed either way.
  if (isLoopbackBaseUrl(baseUrl)) cfg.anonymousKey = "local";
  const hint = (input.rateLimitedHint ?? "").trim();
  return hint.length > 0 ? { ...cfg, rateLimitedHint: hint } : cfg;
}

function isValidRecord(r: unknown): r is ProviderConfig {
  if (typeof r !== "object" || r === null) return false;
  const c = r as Record<string, unknown>;
  return typeof c["id"] === "string" && ID_RX.test((c["id"] as string).toLowerCase())
    && !isBuiltinProviderId((c["id"] as string).toLowerCase())
    && typeof c["baseUrl"] === "string" && isAllowedBaseUrl(c["baseUrl"] as string)
    && typeof c["defaultModel"] === "string" && (c["defaultModel"] as string).length > 0
    && typeof c["envVar"] === "string" && ENV_RX.test(c["envVar"] as string)
    && typeof c["chatPath"] === "string" && typeof c["modelsPath"] === "string"
    && typeof c["timeoutMs"] === "number";
}

/** All valid user-registered providers. Never throws — missing/corrupt file reads as {}. */
export function loadCustomProviders(dir?: string): Record<string, ProviderConfig> {
  try {
    const raw = fs.readFileSync(customProvidersPath(dir), "utf8");
    const data = JSON.parse(raw) as { providers?: unknown };
    if (!Array.isArray(data.providers)) return {};
    const out: Record<string, ProviderConfig> = {};
    for (const r of data.providers) {
      if (isValidRecord(r)) out[r.id.toLowerCase()] = { ...r, id: r.id.toLowerCase() };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Registered custom providers pointing at a local runtime (loopback http).
 * The router's `private` class uses these: they are the only providers that can
 * see a secret-bearing prompt without it leaving the machine.
 */
export function listLocalProviders(dir?: string): ProviderConfig[] {
  return Object.values(loadCustomProviders(dir))
    .filter((c) => isLoopbackBaseUrl(c.baseUrl))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Builtin first, then customs (case-insensitive). Null when unknown. */
export function getProviderConfig(id: string, dir?: string): ProviderConfig | null {
  const key = id.trim().toLowerCase();
  if (isBuiltinProviderId(key)) return PROVIDERS[key];
  return loadCustomProviders(dir)[key] ?? null;
}

/** Builtins in registry order, then customs alphabetically. */
const DISABLED_FILE = "disabled-providers.json";

/** Read the set of disabled provider ids. Never throws — missing/empty reads as empty set. */
export function getDisabledProviders(dir?: string): Set<string> {
  try {
    const raw = fs.readFileSync(path.join(dir ?? configDir(), DISABLED_FILE), "utf8");
    const data = JSON.parse(raw) as { disabled?: unknown };
    if (!Array.isArray(data.disabled)) return new Set();
    return new Set(data.disabled.map(String));
  } catch {
    return new Set();
  }
}

/** Write the disabled provider ids set. Never throws. */
function writeDisabledProviders(disabled: Set<string>, dir?: string): void {
  try {
    const target = dir ?? configDir();
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const file = path.join(target, DISABLED_FILE);
    fs.writeFileSync(file, JSON.stringify({ disabled: [...disabled].sort() }, null, 2) + "\n", "utf8");
    lockFileOwnerOnly(file);
  } catch { /* best-effort */ }
}

/**
 * @deprecated Provider-level disable is superseded by the per-model consent
 * allowlist (model-allowlist.ts). Reads stay supported for old config files;
 * nothing enforces this flag anymore.
 */
export function setProviderDisabled(id: string, disabled: boolean, dir?: string): void {
  const current = getDisabledProviders(dir);
  if (disabled) current.add(id); else current.delete(id);
  writeDisabledProviders(current, dir);
}

export function isProviderDisabled(id: string, dir?: string): boolean {
  return getDisabledProviders(dir).has(id);
}

export function listAllProviderConfigs(dir?: string): ProviderConfig[] {
  const disabled = getDisabledProviders(dir);
  const customs = Object.values(loadCustomProviders(dir)).filter((c) => !disabled.has(c.id)).sort((a, b) => a.id.localeCompare(b.id));
  const builtins = Object.values(PROVIDERS).filter((c) => !disabled.has(c.id));
  return [...builtins, ...customs];
}

/** All providers including disabled ones, for the auth UI. */
export function listAllProviderConfigsWithDisabled(dir?: string): ProviderConfig[] {
  const disabled = getDisabledProviders(dir);
  const all = [...Object.values(PROVIDERS), ...Object.values(loadCustomProviders(dir))].sort((a, b) => a.id.localeCompare(b.id));
  return all.map((c) => ({ ...c, disabled: disabled.has(c.id) }));
}

function writeCustomProviders(next: Record<string, ProviderConfig>, dir?: string): boolean {
  try {
    const target = dir ?? configDir();
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const list = Object.values(next).sort((a, b) => a.id.localeCompare(b.id));
    const file = path.join(target, CUSTOM_PROVIDERS_FILE);
    fs.writeFileSync(file, JSON.stringify({ providers: list }, null, 2) + "\n", "utf8");
    lockFileOwnerOnly(file);
    return true;
  } catch {
    return false;
  }
}

export function addCustomProvider(input: CustomProviderInput, dir?: string): { ok: true; id: string } | { ok: false; error: string } {
  const cfg = normalize(input);
  if ("error" in cfg) return { ok: false, error: cfg.error };
  const next = loadCustomProviders(dir);
  if (next[cfg.id] !== undefined) return { ok: false, error: `"${cfg.id}" is already registered (remove first to replace)` };
  next[cfg.id] = cfg;
  if (!writeCustomProviders(next, dir)) return { ok: false, error: "failed to write custom-providers.json (disk write)" };
  // Registration IS consent: the exact default model you just named is
  // enabled. Everything else on this gateway stays off until explicitly
  // enabled — no wildcard entries exist.
  enableEntries([`${cfg.id}:${cfg.defaultModel}`], dir);
  return { ok: true, id: cfg.id };
}

export function removeCustomProvider(id: string, dir?: string): { ok: true } | { ok: false; error: string } {
  const key = id.trim().toLowerCase();
  if (isBuiltinProviderId(key)) return { ok: false, error: `"${key}" is a builtin provider and cannot be removed` };
  const next = loadCustomProviders(dir);
  if (next[key] === undefined) return { ok: false, error: `unknown provider "${id}" (see: codewhip provider list)` };
  delete next[key];
  if (!writeCustomProviders(next, dir)) return { ok: false, error: "failed to write custom-providers.json (disk write)" };
  // A removed provider must leave no live allowlist entries behind.
  disableEntries(allowedModelsFor(key, dir).map((m) => `${key}:${m}`), dir);
  return { ok: true };
}
