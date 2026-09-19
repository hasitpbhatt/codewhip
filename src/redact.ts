const PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{6,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]+\b/g,
  // Generic high-entropy token (bare key leak without an env name):
  // 20+ chars, at least one letter and three digits — avoids masking
  // ordinary filenames (e.g. top-10-things-learned-late.md) while
  // catching mistral/sensenova/alibaba-style tokens.
  // Best-effort by design; .env read-denial remains the first net.
  /\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=(?:[^0-9]*[0-9]){3})[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/**
 * Pure secret scrubber. Called at the model boundary (loop transcript push)
 * and at write boundaries (outcomes/audit/share) — never as display plumbing.
 * Keys, tokens, private keys, emails → [redacted]. Pattern-based, best-effort:
 * reads that return exotic secret formats still need the .env read-denial net.
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rx of PATTERNS) {
    rx.lastIndex = 0;
    out = out.replace(rx, "[redacted]");
  }
  return out;
}

// Shell/.env-style assignments: `export FOO=bar`, `FOO=bar`, `FOO: bar`
// (docker-compose). The name is kept (useful for debugging a share bundle);
// the value is masked. Two nets: ALL-CAPS names (any value), plus any-case
// names containing a secret word (key|secret|token|passw|credential|private
// — substring, aggressive by design: `monkey = x` masks too). Only applied
// on the share path — the model boundary keeps current behavior so prompts
// aren't mangled.
const ENV_CAPS_RX = /^(\s*(?:export\s+)?[A-Z_][A-Z0-9_]*\s*[:=])\s*\S.*$/gm;
const ENV_SECRET_RX = /^(\s*(?:export\s+)?[A-Za-z0-9_]*(?:key|secret|token|passw|credential|private)[A-Za-z0-9_]*\s*[:=])\s*\S.*$/gim;

export function redactEnvValues(text: string): string {
  ENV_CAPS_RX.lastIndex = 0;
  ENV_SECRET_RX.lastIndex = 0;
  return text
    .replace(ENV_CAPS_RX, (_m, head: string) => `${head} [redacted]`)
    .replace(ENV_SECRET_RX, (_m, head: string) => `${head} [redacted]`);
}
