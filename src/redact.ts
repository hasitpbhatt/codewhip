const PATTERNS: RegExp[] = [
  /nvapi-[A-Za-z0-9_-]+/g,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bghp_[A-Za-z0-9]+\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
];

/**
 * Pure secret scrubber. Call at write boundaries (outcomes/audit/share),
 * never as display plumbing. Keys, tokens, private keys, emails → [redacted].
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rx of PATTERNS) {
    rx.lastIndex = 0;
    out = out.replace(rx, "[redacted]");
  }
  return out;
}
