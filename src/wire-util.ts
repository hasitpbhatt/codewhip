/**
 * Wire-level helpers shared by the provider ports.
 *
 * These live outside provider.ts because provider.ts imports the ports
 * (src/onemin.ts) and a port that imported the registry back would form a
 * runtime cycle through the module that constructs it. Both helpers are pure
 * and stateless, so a shared home costs nothing.
 */

/**
 * Account-scoped base URLs. Some providers scope their API by a per-user id in
 * the path — Cloudflare Workers AI serves the OpenAI-compatible surface under
 * `/accounts/<account_id>/ai`. The id is not a secret but it is per-user, so a
 * row carries a `{ENV_VAR}` placeholder resolved from the environment when the
 * URL is built rather than being hardcoded.
 *
 * Substitution happens ONLY at URL construction. `candidateBaseUrls()` and the
 * `host` recorded in provider-stats.jsonl keep the template, so no account id
 * is ever written to disk or into the stats log.
 */
const BASE_URL_PLACEHOLDER = /\{([A-Z][A-Z0-9_]*)\}/g;

/** Env var names a base URL still needs before it can be called (empty = ready). */
export function unresolvedBaseUrlVars(baseUrl: string): string[] {
  const missing: string[] = [];
  for (const match of baseUrl.matchAll(BASE_URL_PLACEHOLDER)) {
    if ((process.env[match[1]] ?? "").length === 0) {
      missing.push(match[1]);
    }
  }
  return missing;
}

/** Fill `{ENV_VAR}` placeholders from the environment. Unset vars become "". */
export function resolveBaseUrl(baseUrl: string): string {
  return baseUrl.replace(BASE_URL_PLACEHOLDER, (_whole, name: string) => process.env[name] ?? "");
}

/**
 * Parse a Retry-After header (delay seconds or HTTP-date) into ms,
 * capped at 60s. Undefined when absent, malformed, past, or wild.
 */
export function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) {
    return undefined;
  }
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    if (!Number.isFinite(ms) || ms < 0) {
      return undefined;
    }
    return Math.min(ms, 60000);
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  const diff = at - Date.now();
  if (diff < 0) {
    return undefined;
  }
  return Math.min(diff, 60000);
}
