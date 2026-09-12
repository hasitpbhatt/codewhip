import type { LoopMsg } from "./provider-port.js";

/**
 * Transcript compaction (committee ruling 3: designed, not defaulted).
 * Sessions must survive their own context window — long runs die when old
 * tool outputs (file dumps, command logs) crowd out the working tail.
 *
 * Two pruning tiers, oldest-first, never touching the system prompt, the
 * original user prompt, or the most recent exchanges:
 *   1. TRUNCATE — old tool outputs over `TOOL_KEEP_CHARS` are cut down with
 *      a visible `…[compacted]` marker. Message structure is preserved.
 *   2. ELIDE — if still over budget, whole old exchanges (assistant +
 *      its tool responses) are replaced by one text stub naming the tools
 *      called. No orphan tool responses: units move as a block.
 *
 * No tokenizer dependency: tokens are estimated as chars/4 and every
 * printed number says "est." — honest arithmetic beats fake precision.
 */

export const DEFAULT_COMPACT_TOKENS = 60000;
/** Old tool outputs keep their head at this many chars. */
const TOOL_KEEP_CHARS = 600;
/** The newest N non-protected units are never compacted. */
const KEEP_RECENT_UNITS = 2;

/** chars/4 estimate over the whole transcript (labels: "est."). */
export function estimateTokens(messages: LoopMsg[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += charLength(m);
  }
  return Math.ceil(chars / 4);
}

function charLength(m: LoopMsg): number {
  let chars = m.content.length + 24;
  if (m.toolCalls !== undefined) {
    for (const c of m.toolCalls) chars += c.name.length + c.argsJson.length + 16;
  }
  return chars;
}

/** One contiguous run of messages: an assistant (or user/system) turn plus any tool responses it owns. */
type Unit = { start: number; end: number; protected: boolean };

function segmentUnits(messages: LoopMsg[]): Unit[] {
  const units: Unit[] = [];
  let i = 0;
  while (i < messages.length) {
    const start = i;
    i += 1;
    while (i < messages.length && messages[i]?.role === "tool") i += 1;
    const role = messages[start]?.role;
    units.push({ start, end: i, protected: role === "system" || role === "user" });
  }
  return units;
}

/** Units compaction may touch: not system/user, not among the newest few. */
function eligibleUnits(messages: LoopMsg[]): Unit[] {
  const nonProtected = segmentUnits(messages).filter((u) => !u.protected);
  const recent = new Set(nonProtected.slice(-KEEP_RECENT_UNITS));
  return nonProtected.filter((u) => !recent.has(u));
}

function truncateToolContent(content: string): string {
  return content.slice(0, TOOL_KEEP_CHARS) + `\n…[compacted: ${content.length - TOOL_KEEP_CHARS} chars elided]`;
}

export type CompactResult = {
  messages: LoopMsg[];
  /** Old tool outputs shortened at tier 1. */
  truncated: number;
  /** Whole old exchanges replaced by a stub at tier 2. */
  dropped: number;
  tokensBefore: number;
  tokensAfter: number;
};

/**
 * Pure function: returns a transcript under `thresholdTokens` when
 * possible, plus counters for the receipt. The input is never mutated.
 */
export function compactTranscript(messages: LoopMsg[], thresholdTokens: number): CompactResult {
  const tokensBefore = estimateTokens(messages);
  if (messages.length === 0 || tokensBefore <= thresholdTokens) {
    return { messages, truncated: 0, dropped: 0, tokensBefore, tokensAfter: tokensBefore };
  }
  const out: LoopMsg[] = [...messages];
  let truncated = 0;
  let dropped = 0;

  // Tier 1 — shorten old tool outputs. Cheap, keeps all structure.
  for (const u of eligibleUnits(out)) {
    for (let i = u.start; i < u.end; i++) {
      const m = out[i];
      if (m === undefined || m.role !== "tool" || m.content.length <= TOOL_KEEP_CHARS) continue;
      out[i] = { ...m, content: truncateToolContent(m.content) };
      truncated += 1;
    }
    if (estimateTokens(out) <= thresholdTokens) {
      return { messages: out, truncated, dropped, tokensBefore, tokensAfter: estimateTokens(out) };
    }
  }

  // Tier 2 — elide whole oldest units (assistant + tool responses move as
  // a block, so no orphan tool responses) until under budget or nothing
  // eligible remains. Splices shift indices, so eligibility is re-derived
  // every iteration. Already-elided stubs are skipped, not re-elided.
  for (;;) {
    if (estimateTokens(out) <= thresholdTokens) break;
    const unit = eligibleUnits(out).find((u) => !(out[u.start]?.content.startsWith("[compacted:") ?? false));
    if (unit === undefined) break;
    const tools = out
      .slice(unit.start, unit.end)
      .flatMap((m) => (m.toolCalls ?? []).map((c) => c.name));
    const stub: LoopMsg = {
      role: "assistant",
      content:
        tools.length > 0
          ? `[compacted: this exchange called ${tools.join(", ")} — its steps and outputs were elided to keep the run under the context budget]`
          : "[compacted: an earlier exchange was elided to keep the run under the context budget]",
    };
    out.splice(unit.start, unit.end - unit.start, stub);
    dropped += 1;
  }
  return { messages: out, truncated, dropped, tokensBefore, tokensAfter: estimateTokens(out) };
}
