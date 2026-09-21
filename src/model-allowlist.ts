import * as fs from "node:fs";
import * as path from "node:path";
import { configDir } from "./config-dir.js";
import { lockFileOwnerOnly } from "./secure-file.js";

/**
 * Per-model consent allowlist — the deny-by-default gate for every call
 * surface (serve proxy, CLI runs, auto-routing).
 *
 * State: `{ "allowed": ["provider:model", …] }` in `allowed-models.json`
 * next to the other config files. Entries are EXACT ids only — there is no
 * wildcard; "enable a whole provider" is a bulk write of its currently
 * listed model ids, so a live-catalog change can never silently re-open
 * access.
 *
 * IMPORTANT inversion: a missing or corrupt file reads as EMPTY = DENY
 * EVERYTHING. Every other state file in this codebase treats corruption as
 * "harmless empty"; here empty is the strictest state, and that is the
 * point (consent posture, not convenience cache).
 *
 * Layering: allowlist = consent (checked at call sites) → blocklist =
 * capability (wire-level, provider.ts 410 gate) → health/eligibility =
 * billing. All three must pass; this module only owns the first.
 */

export const ALLOWED_FILE = "allowed-models.json";

const PROVIDER_RX = /^[a-z0-9][a-z0-9-]{1,31}$/;
const MAX_MODEL_LEN = 200;

export function allowedPath(dir?: string): string {
  return path.join(dir ?? configDir(), ALLOWED_FILE);
}

export type ModelKey = { provider: string; model: string };

/** Parse one raw entry. Provider lowercase; model verbatim (may contain ":"). */
export function parseEntry(raw: string): ModelKey | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0 || colon === trimmed.length - 1) return null;
  const provider = trimmed.slice(0, colon).toLowerCase();
  const model = trimmed.slice(colon + 1);
  if (!PROVIDER_RX.test(provider)) return null;
  if (model.length === 0 || model.length > MAX_MODEL_LEN) return null;
  // No wildcard smuggles: "*" is not an allowable model or provider, ever.
  if (provider === "*" || model === "*") return null;
  if (/[\x00-\x1f\x7f]/.test(model)) return null; // eslint-disable-line no-control-regex
  return { provider, model };
}

const keyOf = (k: ModelKey): string => `${k.provider}:${k.model}`;

function normalizeList(entries: unknown): ModelKey[] {
  if (!Array.isArray(entries)) return [];
  const seen = new Set<string>();
  const out: ModelKey[] = [];
  for (const raw of entries) {
    const k = typeof raw === "string" ? parseEntry(raw) : null;
    if (k === null) continue;
    const key = keyOf(k);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out.sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** Never throws — missing/corrupt file reads as [] (which means deny-all). */
export function loadAllowedEntries(dir?: string): string[] {
  try {
    const raw = fs.readFileSync(allowedPath(dir), "utf8");
    const data = JSON.parse(raw) as { allowed?: unknown };
    return normalizeList(data.allowed).map(keyOf);
  } catch {
    return [];
  }
}

/** Best-effort write, owner-only. Returns false on disk failure. */
export function saveAllowedEntries(entries: string[], dir?: string): boolean {
  try {
    const target = dir ?? configDir();
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const file = path.join(target, ALLOWED_FILE);
    const list = normalizeList(entries).map(keyOf);
    fs.writeFileSync(file, JSON.stringify({ allowed: list }, null, 2) + "\n", "utf8");
    lockFileOwnerOnly(file);
    return true;
  } catch {
    return false;
  }
}

/** The one question every call site asks. Exact match only — no wildcards. */
export function isModelAllowed(provider: string, model: string, dir?: string): boolean {
  const p = provider.trim().toLowerCase();
  return loadAllowedEntries(dir).includes(`${p}:${model}`);
}

/** Enabled model ids for one provider, sorted. */
export function allowedModelsFor(provider: string, dir?: string): string[] {
  const p = provider.trim().toLowerCase();
  return loadAllowedEntries(dir)
    .map((e) => parseEntry(e))
    .filter((k): k is ModelKey => k !== null && k.provider === p)
    .map((k) => k.model);
}

/** True iff at least one exact entry names this provider. */
export function providerIsEnabled(provider: string, dir?: string): boolean {
  return allowedModelsFor(provider, dir).length > 0;
}

export type AllowlistResult = { ok: true; added: string[] } | { ok: false; error: string };

/** Validate-then-add. Any malformed entry in the batch rejects the batch. */
export function enableEntries(entries: string[], dir?: string): AllowlistResult {
  const keys: ModelKey[] = [];
  for (const raw of entries) {
    const k = parseEntry(raw);
    if (k === null) return { ok: false, error: `bad entry "${raw}" (need provider:model, exact id, no wildcards)` };
    keys.push(k);
  }
  const current = normalizeList(loadAllowedEntries(dir));
  const before = new Set(current.map(keyOf));
  const added: string[] = [];
  for (const k of keys) {
    const key = keyOf(k);
    if (!before.has(key)) {
      before.add(key);
      current.push(k);
      added.push(key);
    }
  }
  if (added.length > 0 && !saveAllowedEntries(current.map(keyOf), dir)) {
    return { ok: false, error: "failed to write allowed-models.json (disk write)" };
  }
  return { ok: true, added };
}

/** Remove exact entries; unknown ones are silently absent. */
export function disableEntries(entries: string[], dir?: string): { ok: true; removed: string[] } | { ok: false; error: string } {
  const keys = entries.map((e) => parseEntry(e));
  const bad = entries.filter((_, i) => keys[i] === null);
  if (bad.length > 0) return { ok: false, error: `bad entry "${bad[0]}" (need provider:model, exact id, no wildcards)` };
  const drop = new Set((keys as ModelKey[]).map(keyOf));
  const current = normalizeList(loadAllowedEntries(dir));
  const removed = current.map(keyOf).filter((k) => drop.has(k));
  const next = current.filter((k) => !drop.has(keyOf(k)));
  if (removed.length > 0 && !saveAllowedEntries(next.map(keyOf), dir)) {
    return { ok: false, error: "failed to write allowed-models.json (disk write)" };
  }
  return { ok: true, removed };
}

/**
 * Replace one provider's entries with `models` (full state of that provider).
 * models=[] disables the provider entirely. Other providers untouched.
 */
export function setProviderAllowlist(
  provider: string,
  models: string[],
  dir?: string,
): { ok: true; allowed: string[] } | { ok: false; error: string } {
  const p = provider.trim().toLowerCase();
  if (!PROVIDER_RX.test(p)) return { ok: false, error: `bad provider id "${provider}"` };
  if (!Array.isArray(models)) return { ok: false, error: 'body { models: ["id", …] } required' };
  const keys: ModelKey[] = [];
  const seen = new Set<string>();
  for (const raw of models) {
    const k = parseEntry(`${p}:${raw}`);
    if (k === null || k.provider !== p) return { ok: false, error: `bad model id "${raw}"` };
    const key = keyOf(k);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(k);
  }
  const next = normalizeList(loadAllowedEntries(dir)).filter((k) => k.provider !== p).concat(keys);
  if (!saveAllowedEntries(next.map(keyOf), dir)) return { ok: false, error: "failed to write allowed-models.json (disk write)" };
  return { ok: true, allowed: keys.map(keyOf).sort((a, b) => a.localeCompare(b)) };
}
