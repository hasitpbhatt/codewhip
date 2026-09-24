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

export function stripHtml(html: string): string {
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
