import { describe, it } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import {
  buildPrompt,
  flattenMessages,
  oneminPort,
  parseEmulatedToolCalls,
  renderToolSpecs,
  unwrapResult,
} from "./onemin.js";
import { PROVIDERS } from "./provider.js";
import type { LoopMsg, ToolSpec } from "./provider-port.js";

const cfg = PROVIDERS["1min"];

const readTool: ToolSpec = {
  name: "read" as ToolSpec["name"],
  description: "Read a file from disk.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

type Captured = { url: string; headers: Record<string, string>; body: string };

/** Swap global fetch for one canned reply, recording what the port sent. */
function stubFetch(reply: () => Response): { calls: Captured[]; restore: () => void } {
  const real = globalThis.fetch;
  const calls: Captured[] = [];
  globalThis.fetch = ((url: string, init: { headers?: Record<string, string>; body?: string }) => {
    calls.push({ url, headers: init.headers ?? {}, body: init.body ?? "" });
    return Promise.resolve(reply());
  }) as unknown as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Minimal successful envelope. */
function okEnvelope(text: string): unknown {
  return { aiRecord: { status: "SUCCESS", aiRecordDetail: { resultObject: [text] } } };
}

describe("onemin prompt building", () => {
  it("renders no tool section when there are no tools", () => {
    strictEqual(renderToolSpecs([]), "");
  });
it("states the exact block shape and lists every tool with its schema", () => {
    const specs = renderToolSpecs([readTool]);
    ok(specs.includes('<tool_call>{"name": "search", "arguments": {"query": "foo"}}</tool_call>'), specs);
    ok(specs.includes("### read"), specs);
    ok(specs.includes("Read a file from disk."), specs);
    ok(specs.includes('"required":["path"]'), specs);
  });
  it("renders an example that the parser itself accepts — the doc and the parser cannot drift", () => {
    // Regression guard: the example block shown to the model must round-trip
    // through parseEmulatedToolCalls. A corrupted template (e.g. literal
    // "MUN" where the tags belong) fails here instead of degrading the
    // provider silently.
    const specs = renderToolSpecs([readTool]);
    const line = specs.split("\n").find((l) => l.trim().startsWith("<tool_call>"));
    ok(line !== undefined, `no example block in specs:\n${specs}`);
    const r = parseEmulatedToolCalls(line as string);
    strictEqual(r.toolCalls.length, 1);
    strictEqual(r.toolCalls[0].name, "search");
    strictEqual(r.toolCalls[0].argsJson, '{"query":"foo"}');
  });
  it("labels every role — with no messages[] array the labels carry the structure", () => {
    const msgs: LoopMsg[] = [
      { role: "system", content: "be terse" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const flat = flattenMessages(msgs);
    ok(flat.includes("[system]\nbe terse"), flat);
    ok(flat.includes("[user]\nhello"), flat);
    ok(flat.includes("[assistant]\nhi"), flat);
  });
  it("tags tool results with their call id so the model can pair them up", () => {
    const flat = flattenMessages([{ role: "tool", content: "file contents", toolCallId: "call_7" }]);
    ok(flat.includes("[tool result call_7]\nfile contents"), flat);
  });
  it("re-renders a prior assistant tool call in the shape the model was asked to produce", () => {
    const flat = flattenMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "read", argsJson: '{"path":"a.ts"}' }] },
    ]);
    ok(flat.includes('<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>'), flat);
  });
  it("survives a tool call whose stored argsJson is not valid JSON", () => {
    const flat = flattenMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "call_0", name: "read", argsJson: "{broken" }] },
    ]);
    ok(flat.includes('<tool_call>{"name":"read","arguments":{}}</tool_call>'), flat);
  });
  it("puts the tool specs ahead of the transcript, and omits the heading without tools", () => {
    const msgs: LoopMsg[] = [{ role: "user", content: "go" }];
    const withTools = buildPrompt(msgs, [readTool]);
    ok(withTools.indexOf("# Tools") < withTools.indexOf("# Conversation"), withTools);
    const without = buildPrompt(msgs, []);
    ok(!without.includes("# Tools"), without);
    strictEqual(without, "[user]\ngo");
  });
});

describe("onemin tool-call parsing", () => {
  it("extracts a tagged call and strips it from the visible text", () => {
    const r = parseEmulatedToolCalls('Let me look.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>');
    strictEqual(r.text, "Let me look.");
    deepStrictEqual(r.toolCalls, [{ id: "call_0", name: "read", argsJson: '{"path":"a.ts"}' }]);
  });
  it("extracts several calls and numbers them in order", () => {
    const r = parseEmulatedToolCalls(
      '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call><tool_call>{"name":"bash","arguments":{"cmd":"ls"}}</tool_call>'
    );
    strictEqual(r.toolCalls.length, 2);
    strictEqual(r.toolCalls[0].name, "read");
    strictEqual(r.toolCalls[1].name, "bash");
    strictEqual(r.toolCalls[1].argsJson, '{"cmd":"ls"}');
  });
  it("falls back to a fenced json block for models that ignore the tag instruction", () => {
    const r = parseEmulatedToolCalls('Sure:\n```json\n{"name":"read","arguments":{"path":"b.ts"}}\n```');
    strictEqual(r.toolCalls.length, 1);
    strictEqual(r.toolCalls[0].name, "read");
    strictEqual(r.text, "Sure:");
  });
  it("leaves an ordinary fenced block alone — not every code block is a tool call", () => {
    const raw = "Here is config:\n```json\n{\"port\": 8080}\n```";
    const r = parseEmulatedToolCalls(raw);
    strictEqual(r.toolCalls.length, 0);
    strictEqual(r.text, raw);
  });
  it("ignores a tagged block whose JSON does not parse", () => {
    const raw = "<tool_call>{not json}</tool_call>";
    const r = parseEmulatedToolCalls(raw);
    strictEqual(r.toolCalls.length, 0);
    strictEqual(r.text, raw);
  });
  it("ignores a call with no name", () => {
    const r = parseEmulatedToolCalls('<tool_call>{"arguments":{"path":"a"}}</tool_call>');
    strictEqual(r.toolCalls.length, 0);
  });
  it("accepts arguments delivered as a JSON string", () => {
    const r = parseEmulatedToolCalls('<tool_call>{"name":"read","arguments":"{\\"path\\":\\"c.ts\\"}"}</tool_call>');
    deepStrictEqual(r.toolCalls, [{ id: "call_0", name: "read", argsJson: '{"path":"c.ts"}' }]);
  });
  it("defaults missing or unusable arguments to an empty object", () => {
    strictEqual(parseEmulatedToolCalls('<tool_call>{"name":"read"}</tool_call>').toolCalls[0].argsJson, "{}");
    strictEqual(parseEmulatedToolCalls('<tool_call>{"name":"read","arguments":null}</tool_call>').toolCalls[0].argsJson, "{}");
    strictEqual(parseEmulatedToolCalls('<tool_call>{"name":"read","arguments":"nope"}</tool_call>').toolCalls[0].argsJson, "{}");
  });
  it("returns the text untouched when no tool call is present", () => {
    const r = parseEmulatedToolCalls("just an answer");
    strictEqual(r.text, "just an answer");
    strictEqual(r.toolCalls.length, 0);
  });
});

describe("onemin response unwrapping", () => {
  it("joins the resultObject string array", () => {
    const r = unwrapResult({ aiRecord: { status: "SUCCESS", aiRecordDetail: { resultObject: ["a", "b"] } } });
    strictEqual(r.text, "a\nb");
    strictEqual(r.status, "SUCCESS");
  });
  it("returns empty text when the envelope is missing or malformed", () => {
    strictEqual(unwrapResult({}).text, "");
    strictEqual(unwrapResult({ aiRecord: { aiRecordDetail: { resultObject: "not-an-array" } } }).text, "");
    strictEqual(unwrapResult({ aiRecord: { aiRecordDetail: { resultObject: [1, "ok", null] } } }).text, "ok");
  });
});

describe("onemin port", () => {
  it("refuses to call without a key", async () => {
    const r = await oneminPort(cfg, "")({ model: "gpt-4o-mini", messages: [], tools: [] });
    strictEqual(r.ok, false);
    if (r.ok) return;
    strictEqual(r.error, "missing api key");
  });
  it("rejects a nonsensical model id before any request", async () => {
    const stub = stubFetch(() => jsonResponse(okEnvelope("hi")));
    try {
      const r = await oneminPort(cfg, "k")({ model: "", messages: [], tools: [] });
      strictEqual(r.ok, false);
      strictEqual(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
  it("sends the 1min body and API-KEY header to /api/chat-with-ai with no stream flag", async () => {
    const stub = stubFetch(() => jsonResponse(okEnvelope("hello")));
    try {
      const port = oneminPort(cfg, "secret-key");
      await port({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], tools: [readTool] });
      strictEqual(stub.calls.length, 1);
      strictEqual(stub.calls[0].url, "https://api.1min.ai/api/chat-with-ai");
      strictEqual(stub.calls[0].headers["API-KEY"], "secret-key");
      const sent = JSON.parse(stub.calls[0].body) as { type: string; model: string; promptObject: { prompt: string } };
      strictEqual(sent.type, "UNIFY_CHAT_WITH_AI");
      strictEqual(sent.model, "gpt-4o-mini");
      ok(sent.promptObject.prompt.includes("[user]\nhi"), sent.promptObject.prompt);
      ok(sent.promptObject.prompt.includes("### read"), sent.promptObject.prompt);
      // conversationId would make 1min append its own server-side history on
      // top of the transcript codewhip already sends.
      strictEqual("conversationId" in sent.promptObject, false);
    } finally {
      stub.restore();
    }
  });
  it("unwraps a SUCCESS record and always labels the token counts estimated", async () => {
    const stub = stubFetch(() => jsonResponse(okEnvelope("quantum computing explained")));
    try {
      const r = await oneminPort(cfg, "k")({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], tools: [] });
      ok(r.ok);
      if (!r.ok) return;
      strictEqual(r.text, "quantum computing explained");
      strictEqual(r.toolCalls.length, 0);
      // 1min returns no usage block, so these can only ever be estimates.
      strictEqual(r.usageEstimated, true);
      ok(r.completionTokens > 0, String(r.completionTokens));
    } finally {
      stub.restore();
    }
  });
  it("turns an emulated tool call in the reply into a real LoopToolCall", async () => {
    const reply = 'Looking now.\n<tool_call>{"name":"read","arguments":{"path":"src/x.ts"}}</tool_call>';
    const stub = stubFetch(() => jsonResponse(okEnvelope(reply)));
    try {
      const r = await oneminPort(cfg, "k")({ model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }], tools: [readTool] });
      ok(r.ok);
      if (!r.ok) return;
      strictEqual(r.text, "Looking now.");
      deepStrictEqual(r.toolCalls, [{ id: "call_0", name: "read", argsJson: '{"path":"src/x.ts"}' }]);
    } finally {
      stub.restore();
    }
  });
  it("maps 401 to an auth failure that names the env var and key console", async () => {
    const stub = stubFetch(() => jsonResponse({ success: false, error: { code: "UNAUTHORIZED", message: "bad key" } }, 401));
    try {
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [] });
      strictEqual(r.ok, false);
      if (r.ok) return;
      strictEqual(r.retryable, "auth");
      ok(r.error.includes("ONEMIN_API_KEY"), r.error);
    } finally {
      stub.restore();
    }
  });
  it("maps 429 to a rate-limited failure and carries Retry-After through", async () => {
    const stub = stubFetch(() => jsonResponse({ success: false, error: { code: "RATE_LIMITED" } }, 429, { "retry-after": "7" }));
    try {
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [] });
      strictEqual(r.ok, false);
      if (r.ok) return;
      strictEqual(r.retryable, "rate-limited");
      strictEqual(r.retryAfterMs, 7000);
    } finally {
      stub.restore();
    }
  });
  it("surfaces the provider's own error code and message", async () => {
    const stub = stubFetch(() =>
      jsonResponse({ success: false, error: { code: "PROMPT_OBJECT_VALIDATION_FAILED", message: "Invalid prompt object" } }, 422)
    );
    try {
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [] });
      strictEqual(r.ok, false);
      if (r.ok) return;
      ok(r.error.includes("PROMPT_OBJECT_VALIDATION_FAILED"), r.error);
      ok(r.error.includes("Invalid prompt object"), r.error);
    } finally {
      stub.restore();
    }
  });
  it("treats a FAILED record as a failure even on HTTP 200", async () => {
    const stub = stubFetch(() => jsonResponse({ aiRecord: { status: "FAILED", aiRecordDetail: { resultObject: [] } } }));
    try {
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [] });
      strictEqual(r.ok, false);
      if (r.ok) return;
      ok(r.error.includes("FAILED"), r.error);
    } finally {
      stub.restore();
    }
  });
  it("fails cleanly on a SUCCESS record that carries no text", async () => {
    const stub = stubFetch(() => jsonResponse(okEnvelope("")));
    try {
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [] });
      strictEqual(r.ok, false);
      if (r.ok) return;
      ok(r.error.includes("no text"), r.error);
    } finally {
      stub.restore();
    }
  });
  it("reports a transport failure as a non-retryable network error", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (() => Promise.reject(new Error("getaddrinfo ENOTFOUND"))) as unknown as typeof fetch;
    try {
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [] });
      strictEqual(r.ok, false);
      if (r.ok) return;
      strictEqual(r.retryable, "other");
      ok(r.error.includes("network error"), r.error);
    } finally {
      globalThis.fetch = real;
    }
  });
  it("reports an already-aborted caller signal as cancelled without calling out", async () => {
    const stub = stubFetch(() => jsonResponse(okEnvelope("hi")));
    try {
      const ctrl = new AbortController();
      ctrl.abort();
      const r = await oneminPort(cfg, "k")({ model: "m", messages: [], tools: [], signal: ctrl.signal });
      strictEqual(r.ok, false);
      if (r.ok) return;
      strictEqual(r.error, "cancelled");
      strictEqual(stub.calls.length, 0);
    } finally {
      stub.restore();
    }
  });
});
