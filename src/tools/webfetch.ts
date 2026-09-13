import type { ToolContext, ToolResult } from "./types.js";

export const WEBFETCH_TIMEOUT_MS = 30000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 6000;

export type WebfetchArgs = {
  url: string;
  format?: string;
};

/** Hand-guard (no new deps): static check instead of zod, like the other tools. */
export function isWebfetchArgs(x: unknown): x is WebfetchArgs {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r["url"] === "string" &&
    (r["format"] === undefined || typeof r["format"] === "string")
  );
}

/**
 * Origin of an https URL, or null. Shared with remember.ts so the stored
 * "always allow" shape and the tool enforce one rule: https origins only.
 * https-only doubles as the SSRF floor — metadata endpoints and localhost
 * tricks are http and never reach fetch.
 */
export function webfetchOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname.length === 0) return null;
  return u.origin;
}

const SKIP_RX = /<(script|style|noscript|iframe|object|embed)[\s>][\s\S]*?<\/\1\s*>/gi;

/**
 * Anchors are preserved as [text](href) BEFORE the tag-strip: a stripped
 * page without its links is prose with the exits removed — the model couldn't
 * follow a citation, a results page yielded no result URLs, and "vary the
 * URL" had no map. This is what makes a search-results page usable via
 * plain webfetch (no separate search tool). hrefs are not resolved against
 * the page origin (relative links stay relative — the model can see that).
 */
function preserveAnchors(html: string): string {
  return html.replace(/<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, dq, sq, bare, inner) => {
    const href = (dq ?? sq ?? bare ?? "").trim();
    const text = stripHtml(inner);
    if (href.length === 0) return text;
    return text.length > 0 ? `[${text}](${href})` : `[${href}](${href})`;
  });
}

function stripHtml(html: string): string {
  const noSkip = html.replace(SKIP_RX, " ");
  const anchored = preserveAnchors(noSkip);
  const noTags = anchored.replace(/<[^>]*>/g, " ");
  return noTags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Fetch a page for the model. Never throws: every failure (bad URL,
 * redirect off https, HTTP error, oversize body, timeout, kill) is a
 * ToolResult string. The full URL is never echoed — query strings can
 * carry tokens, so messages name the origin only.
 */
export async function webfetchTool(
  _ctx: ToolContext,
  args: WebfetchArgs,
  signal?: AbortSignal
): Promise<ToolResult> {
  const raw = args.url.trim();
  if (raw.length === 0) {
    return { ok: false, output: "webfetch: missing required arg `url` (string)" };
  }
  if (raw.length > 2000) {
    return { ok: false, output: "webfetch: `url` too long (max 2000 chars)" };
  }
  const format = args.format ?? "text";
  if (format !== "text" && format !== "html") {
    return { ok: false, output: 'webfetch: `format` must be "text" or "html" (default "text")' };
  }
  const origin = webfetchOrigin(raw);
  if (origin === null) {
    return { ok: false, output: "webfetch: `url` must be a valid https:// URL (http and other schemes are refused)" };
  }
  if (signal !== undefined && signal.aborted) {
    return { ok: false, output: "webfetch: killed" };
  }
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, WEBFETCH_TIMEOUT_MS);
  const onOuter = (): void => ctrl.abort();
  if (signal !== undefined) signal.addEventListener("abort", onOuter, { once: true });
  try {
    const res = await fetch(raw, {
      headers: {
        "User-Agent": "codewhip (agentic CLI)",
        Accept: format === "html" ? "text/html,*/*" : "text/plain,text/html,*/*",
      },
      signal: ctrl.signal,
    });
    if (!res.url.startsWith("https://")) {
      return { ok: false, output: "webfetch: redirect left https — refused" };
    }
    if (!res.ok) {
      return { ok: false, output: `webfetch: HTTP ${res.status} from ${origin} (no content kept)` };
    }
    const len = res.headers.get("content-length");
    if (len !== null && Number(len) > MAX_BODY_BYTES) {
      return { ok: false, output: "webfetch: response exceeds the 1MB cap (no content kept)" };
    }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return { ok: false, output: "webfetch: response exceeds the 1MB cap (no content kept)" };
    }
    const text = new TextDecoder().decode(buf);
    const out = format === "html" ? text : stripHtml(text);
    if (out.length === 0) return { ok: true, output: "(empty)" };
    return {
      ok: true,
      output: out.length > MAX_OUTPUT_CHARS ? out.slice(0, MAX_OUTPUT_CHARS) + "\n… (truncated)" : out,
    };
  } catch {
    if (signal !== undefined && signal.aborted) {
      return { ok: false, output: "webfetch: killed" };
    }
    if (timedOut) {
      return { ok: false, output: `webfetch: timed out after ${WEBFETCH_TIMEOUT_MS}ms` };
    }
    return { ok: false, output: `webfetch: fetch failed (network error at ${origin})` };
  } finally {
    clearTimeout(timer);
    if (signal !== undefined) signal.removeEventListener("abort", onOuter);
  }
}
