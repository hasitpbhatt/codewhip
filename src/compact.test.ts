import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { compactTranscript, estimateTokens, DEFAULT_COMPACT_TOKENS } from "./compact.js";
import type { LoopMsg, LoopRole } from "./provider-port.js";

function bigTool(id: string, chars: number): LoopMsg[] {
  return [
    { role: "assistant" as LoopRole, content: "", toolCalls: [{ id, name: "read", argsJson: `{"path":"f.txt"}` }] },
    { role: "tool" as LoopRole, toolCallId: id, content: "x".repeat(chars) },
  ];
}

function unitCount(messages: LoopMsg[]): number {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]?.role !== "tool") n += 1;
  }
  return n;
}

describe("compact", () => {
  it("estimateTokens scales with content and counts tool args", () => {
    const small = estimateTokens([{ role: "user", content: "a".repeat(400) }]);
    const big = estimateTokens([{ role: "user", content: "a".repeat(4000) }]);
    ok(big > small * 5);
    const withArgs = estimateTokens([
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "read", argsJson: "y".repeat(400) }] },
    ]);
    ok(withArgs > small);
  });

  it("under the threshold: returns the same transcript untouched", () => {
    const messages: LoopMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...bigTool("a", 500),
    ];
    const r = compactTranscript(messages, DEFAULT_COMPACT_TOKENS);
    strictEqual(r.messages, messages);
    strictEqual(r.truncated, 0);
    strictEqual(r.dropped, 0);
  });

  it("tier 1: old tool outputs truncated, recent + system + user intact, no elision", () => {
    const messages: LoopMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...bigTool("old1", 8000),
      ...bigTool("old2", 8000),
      ...bigTool("old3", 8000),
      ...bigTool("old4", 8000),
      ...bigTool("new1", 8000),
      ...bigTool("new2", 8000),
    ];
    const r = compactTranscript(messages, 9000);
    strictEqual(r.dropped, 0);
    ok(r.truncated >= 2, `truncated=${r.truncated}`);
    ok(r.tokensAfter < r.tokensBefore);
    strictEqual(r.messages[0]?.content, "sys");
    strictEqual(r.messages[1]?.content, "task");
    // Truncated old outputs keep a 600-char head and a visible marker.
    const tools = r.messages.filter((m) => m.role === "tool");
    const marked = tools.filter((m) => m.content.includes("[compacted:") && m.content.startsWith("x".repeat(600)));
    ok(marked.length >= 2, `marked=${marked.length}`);
    // The newest two units stay verbatim (full 8000-char outputs).
    const verbatim = tools.filter((m) => m.content.length === 8000);
    ok(verbatim.length >= 2, `verbatim=${verbatim.length}`);
  });

  it("tier 2: whole old exchanges elided to a stub, no orphan tool responses", () => {
    const messages: LoopMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...bigTool("a", 8000),
      ...bigTool("b", 8000),
      ...bigTool("c", 8000),
      ...bigTool("d", 8000),
      ...bigTool("e", 8000),
      ...bigTool("f", 8000),
      { role: "assistant", content: "working" },
      { role: "tool", toolCallId: "z", content: "small result" },
    ];
    const r = compactTranscript(messages, 2000);
    ok(r.dropped >= 1, `dropped=${r.dropped}`);
    // No orphan tool messages: every tool response follows an assistant.
    for (let i = 0; i < r.messages.length; i++) {
      if (r.messages[i]?.role === "tool") {
        ok(r.messages[i - 1]?.role === "assistant", `orphan tool msg at ${i}`);
      }
    }
    // Stubs name the tools that were elided.
    ok(r.messages.some((m) => m.content.startsWith("[compacted: this exchange called read")));
    // Protected head survives.
    strictEqual(r.messages[0]?.content, "sys");
    strictEqual(r.messages[1]?.content, "task");
    ok(estimateTokens(r.messages) < estimateTokens(messages));
  });

  it("elided stubs are never re-elided into noise", () => {
    const messages: LoopMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...bigTool("a", 8000),
      ...bigTool("b", 8000),
      ...bigTool("c", 8000),
      ...bigTool("d", 8000),
    ];
    const once = compactTranscript(messages, 2000);
    const twice = compactTranscript(once.messages, 100);
    // Second pass may truncate but must not pile stub on stub.
    const stubs = twice.messages.filter((m) => m.content.startsWith("[compacted:"));
    ok(stubs.length <= once.dropped + 1, `stubs=${stubs.length}`);
    strictEqual(unitCount(twice.messages) > 0, true);
  });

  it("input transcript is never mutated", () => {
    const messages: LoopMsg[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "task" },
      ...bigTool("a", 8000),
      ...bigTool("b", 8000),
    ];
    const before = JSON.stringify(messages);
    compactTranscript(messages, 1000);
    strictEqual(JSON.stringify(messages), before);
  });
});
