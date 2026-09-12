import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";
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
  if (isBuiltinProviderId(id)) return { error: `"${id}" is a builtin provider — no registration needed` };
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl.startsWith("https://") || baseUrl.length > 200 || /\s/.test(baseUrl)) {
    return { error: "bad --base-url (need https://origin, no trailing slash)" };
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
  const hint = (input.rateLimitedHint ?? "").trim();
  return hint.length > 0 ? { ...cfg, rateLimitedHint: hint } : cfg;
}

function isValidRecord(r: unknown): r is ProviderConfig {
  if (typeof r !== "object" || r === null) return false;
  const c = r as Record<string, unknown>;
  return typeof c["id"] === "string" && ID_RX.test((c["id"] as string).toLowerCase())
    && !isBuiltinProviderId((c["id"] as string).toLowerCase())
    && typeof c["baseUrl"] === "string" && (c["baseUrl"] as string).startsWith("https://")
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

/** Builtin first, then customs (case-insensitive). Null when unknown. */
export function getProviderConfig(id: string, dir?: string): ProviderConfig | null {
  const key = id.trim().toLowerCase();
  if (isBuiltinProviderId(key)) return PROVIDERS[key];
  return loadCustomProviders(dir)[key] ?? null;
}

/** Builtins in registry order, then customs alphabetically. */
export function listAllProviderConfigs(dir?: string): ProviderConfig[] {
  const customs = Object.values(loadCustomProviders(dir)).sort((a, b) => a.id.localeCompare(b.id));
  return [...Object.values(PROVIDERS), ...customs];
}

function writeCustomProviders(next: Record<string, ProviderConfig>, dir?: string): boolean {
  try {
    const target = dir ?? configDir();
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const list = Object.values(next).sort((a, b) => a.id.localeCompare(b.id));
    fs.writeFileSync(path.join(target, CUSTOM_PROVIDERS_FILE), JSON.stringify({ providers: list }, null, 2) + "\n", "utf8");
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
  return { ok: true, id: cfg.id };
}

export function removeCustomProvider(id: string, dir?: string): { ok: true } | { ok: false; error: string } {
  const key = id.trim().toLowerCase();
  if (isBuiltinProviderId(key)) return { ok: false, error: `"${key}" is a builtin provider and cannot be removed` };
  const next = loadCustomProviders(dir);
  if (next[key] === undefined) return { ok: false, error: `unknown provider "${id}" (see: codewhip provider list)` };
  delete next[key];
  if (!writeCustomProviders(next, dir)) return { ok: false, error: "failed to write custom-providers.json (disk write)" };
  return { ok: true };
}
