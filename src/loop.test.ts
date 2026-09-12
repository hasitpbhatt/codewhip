import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, withTimeout, type LoopEvent } from "./loop.js";
import { makeFakePort, textTurn, toolTurn, rateLimited, timeoutFailure, authFailure } from "./testkit/fakePort.js";
import { listRules } from "./remember-store.js";
import type { RememberedRule } from "./remember-store.js";
import { readAuditLog, verifyChain } from "./audit.js";
import type { ToolResult } from "./tools/types.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-"));
function stubAsk(_q: string): Promise<"yes" | "always" | "no"> {
  return Promise.resolve("yes");
}

describe("loop", () => {
  it("happy path: tool call then text answer", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hi" }), { prompt: 10, completion: 5 }),
      textTurn("done", { prompt: 20, completion: 5 }),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.toolCalls, 1);
    strictEqual(r.error, undefined);
  });
  it("denied by denylist reaches transcript", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "rm -rf /" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    ok(ev.some((t) => t.includes("deny")));
    strictEqual(r.error, undefined);
  });
  it("appends every tool call to the hash-chained audit log", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-audit-"));
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "rm -rf /" }), { prompt: 10, completion: 0 }),
      toolTurn("bash", JSON.stringify({ command: "echo hi" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(runCwd),
    });
    strictEqual(r.toolCalls, 2);
    strictEqual(r.trace.length, 2);
    strictEqual(r.trace[0]?.policy, "deny:denylist:rm -rf /");
    strictEqual(r.trace[1]?.actor, "yolo");
    const { entries } = readAuditLog(runCwd);
    strictEqual(entries.length, 2);
    strictEqual(entries[0]?.tool, "bash");
    strictEqual(entries[0]?.actor, "policy");
    ok((entries[0]?.policy ?? "").startsWith("deny:"), entries[0]?.policy);
    strictEqual(entries[1]?.actor, "yolo");
    ok((entries[1]?.policy ?? "").startsWith("allow:"), entries[1]?.policy);
    const v = verifyChain(runCwd);
    strictEqual(v.valid, true);
    strictEqual(v.total, 2);
  });
  it("a declined ask records its shape into outcomes.jsonl", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-decline-"));
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hi" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: async () => "no", remembered: listRules(runCwd),
    });
    strictEqual(r.toolCalls, 1);
    const raw = fs.readFileSync(path.join(runCwd, ".codewhip", "outcomes.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      tool_calls: { decision: string; ruleId: string; shape?: string }[];
    };
    strictEqual(last.tool_calls.length, 1);
    strictEqual(last.tool_calls[0]?.decision, "deny");
    ok((last.tool_calls[0]?.ruleId ?? "").endsWith("+declined"));
    strictEqual(last.tool_calls[0]?.shape, "echo hi *");
  });
  it("remembered shape auto-allows without asking", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hi" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: async () => "no",
      onEvent: (e) => ev.push(e.text),
      remembered: [{ tool: "bash", shape: "echo *", ts: "", runId: "", preview_hash: "" }],
    });
    ok(ev.some((t) => t.includes("remembered")), ev.join(" "));
    strictEqual(r.toolCalls, 1);
  });
  it("remembered shape matches the bare head too", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: async () => "no",
      onEvent: (e) => ev.push(e.text),
      remembered: [{ tool: "bash", shape: "echo *", ts: "", runId: "", preview_hash: "" }],
    });
    ok(ev.some((t) => t.includes("remembered")), ev.join(" "));
    strictEqual(r.toolCalls, 1);
  });
  it("withTimeout aborts the run's signal when the wall clock elapses", async () => {
    let seen: AbortSignal | undefined;
    const result = await withTimeout((signal) => {
      seen = signal;
      return new Promise<ToolResult>(() => {});
    }, 20);
    ok(result.output.includes("timed out after 20ms"));
    ok(seen !== undefined && seen.aborted === true);
  });
  it("withTimeout returns the tool value when it beats the clock", async () => {
    let seen: AbortSignal | undefined;
    const result = await withTimeout((signal) => {
      seen = signal;
      return Promise.resolve({ ok: true, output: "fast" } as ToolResult);
    }, 500);
    strictEqual(result.output, "fast");
    ok(seen !== undefined && seen.aborted === false);
  });
  it("withTimeout forwards an outer abort to the run", async () => {
    const outer = new AbortController();
    outer.abort();
    const result = await withTimeout(
      (signal) =>
        signal.aborted
          ? Promise.resolve({ ok: false, output: "cancelled" } as ToolResult)
          : new Promise<ToolResult>(() => {}),
      500,
      outer.signal
    );
    strictEqual(result.output, "cancelled");
  });
  it("redacts secrets from tool output before it reaches the provider", async () => {
    const { port, messagesSeen } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo sk-abcDEF123xyz" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    strictEqual(r.error, undefined);
    // Second provider call carries the tool result in the transcript.
    const toolMsg = messagesSeen[1]?.find((m) => m.role === "tool");
    ok(toolMsg !== undefined && toolMsg.content.includes("[redacted]"));
    ok(!toolMsg.content.includes("abcDEF123xyz"));
  });
  it("passes ordinary tool output through unchanged", async () => {
    const { port, messagesSeen } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hello" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    strictEqual(r.error, undefined);
    const toolMsg = messagesSeen[1]?.find((m) => m.role === "tool");
    ok(toolMsg !== undefined && toolMsg.content.includes("hello"));
    ok(!toolMsg.content.includes("redacted"));
  });
  it("rotation tries each candidate once on 429", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([rateLimited(), rateLimited(), textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "a", models: ["a", "b", "c"], label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    ok(ev.some((t) => t.includes("rotating")));
    strictEqual(r.text, "done");
  });
  it("timeout rotates through candidates like a 429 (fresh attempt beats waiting)", async () => {
    const ev: string[] = [];
    const { port, record } = makeFakePort([timeoutFailure(), timeoutFailure(), textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "a", models: ["a", "b", "c"], label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.error, undefined);
    ok(ev.some((t) => t.includes("timed out") && t.includes("rotating")));
    strictEqual(record.map((c) => c.model).join(","), "a,b,c");
  });
  it("timeout never triggers retry-wait (waiting helps 429s, not slow models)", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([timeoutFailure()]);
    const r = await agentLoop({
      prompt: "hi", model: "a", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, retryWait: true,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    ok(!ev.some((t) => t.includes("waiting")));
    ok(r.error !== undefined && r.error.includes("--models"));
  });
  it("unarmed timeout names its remedy (rotate, fail over, or allow longer calls)", async () => {
    const { port } = makeFakePort([timeoutFailure()]);
    const r = await agentLoop({
      prompt: "hi", model: "a", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    ok(r.error !== undefined && r.error.includes("timed out after"));
    ok(r.error.includes("--models <a,b>"));
    ok(r.error.includes("--failover"));
    ok(r.error.includes("--timeout-ms"));
  });
  it("remembered webfetch host skips approval (one yes covers sibling paths)", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve({
        ok: true,
        status: 200,
        url: "https://docs.example.com/a",
        headers: { get: () => null },
        arrayBuffer: () => Promise.resolve(new TextEncoder().encode("<p>hi</p>").buffer as ArrayBuffer),
      } as unknown as Response)) as typeof fetch;
    try {
      let asked = 0;
      const neverAsk = (_q: string): Promise<"yes" | "always" | "no"> => {
        asked += 1;
        return Promise.resolve("yes");
      };
      const remembered: RememberedRule[] = [
        { tool: "webfetch", shape: "https://docs.example.com", ts: new Date().toISOString(), runId: "r", preview_hash: "h" },
      ];
      const { port } = makeFakePort([
        toolTurn("webfetch", JSON.stringify({ url: "https://docs.example.com/a" })),
        toolTurn("webfetch", JSON.stringify({ url: "https://docs.example.com/b" })),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
        stdinIsTTY: true, port, askUser: neverAsk, remembered,
      });
      strictEqual(r.error, undefined);
      strictEqual(r.text, "done");
      strictEqual(asked, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("plan mode: even --yolo cannot grant edit/write/bash, and nothing is touched", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-plan-"));
    fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
    const { port } = makeFakePort([
      toolTurn("edit", JSON.stringify({ path: "f.txt", oldString: "hello", newString: "bye" })),
      toolTurn("write", JSON.stringify({ path: "g.txt", content: "x" })),
      toolTurn("bash", JSON.stringify({ command: "echo hi" })),
      textTurn("here is the plan"),
    ]);
    const ev: string[] = [];
    const r = await agentLoop({
      prompt: "plan this", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 10, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, planMode: true,
      onEvent: (e) => ev.push(e.text), remembered: listRules(runCwd),
    });
    strictEqual(r.text, "here is the plan");
    strictEqual(r.trace.length, 3);
    ok(r.trace.every((t) => t.policy === "deny:plan:read-only"), JSON.stringify(r.trace.map((t) => t.policy)));
    ok(ev.some((t) => t.includes("(plan:read-only)")), ev.join(" "));
    strictEqual(fs.readFileSync(path.join(runCwd, "f.txt"), "utf8"), "hello\n");
    ok(!fs.existsSync(path.join(runCwd, "g.txt")));
    const v = verifyChain(runCwd);
    strictEqual(v.valid, true);
    strictEqual(v.total, 3);
  });
  it("plan mode: read/search stay allowed so research still works", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-plan-"));
    fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
    const { port, messagesSeen } = makeFakePort([
      toolTurn("read", JSON.stringify({ path: "f.txt" })),
      toolTurn("bash", JSON.stringify({ command: "echo hi" })),
      textTurn("plan ready"),
    ]);
    const r = await agentLoop({
      prompt: "plan this", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, planMode: true, remembered: listRules(runCwd),
    });
    strictEqual(r.text, "plan ready");
    strictEqual(r.trace.length, 2);
    strictEqual(r.trace[0]?.policy, "allow:default:read:allow");
    strictEqual(r.trace[1]?.policy, "deny:plan:read-only");
    const readMsg = messagesSeen[1]?.find((m) => m.role === "tool");
    ok(readMsg !== undefined && readMsg.content.includes("hello"));
  });
  it("plan mode: a remembered rule cannot bypass the read-only run", async () => {
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hi" })),
      textTurn("plan ready"),
    ]);
    const r = await agentLoop({
      prompt: "plan this", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: async () => "yes", planMode: true,
      remembered: [{ tool: "bash", shape: "echo *", ts: "", runId: "", preview_hash: "" }],
    });
    strictEqual(r.trace.length, 1);
    strictEqual(r.trace[0]?.policy, "deny:plan:read-only");
  });
  it("plan mode: the system prompt tells the model to answer with a plan", async () => {
    const { port, messagesSeen } = makeFakePort([textTurn("plan ready")]);
    await agentLoop({
      prompt: "plan this", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, planMode: true, remembered: listRules(cwd),
    });
    ok(messagesSeen[0]?.[0]?.content.includes("PLAN MODE"));
  });
  it("no plan mode: the system prompt is unchanged", async () => {
    const { port, messagesSeen } = makeFakePort([textTurn("done")]);
    await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    ok(!messagesSeen[0]?.[0]?.content.includes("PLAN MODE"));
  });
  it("token budget stops the run with a partial receipt", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([textTurn("one", { prompt: 300000, completion: 0 })]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
      tokenBudget: 250000,
    });
    ok(r.error !== undefined && r.error.includes("token budget exhausted"));
    ok(ev.some((t) => t.includes("budget")));
  });
  it("chain hops in order: primary → target1 → target2, one failover event per hop", async () => {
    const ev: LoopEvent[] = [];
    const primary = makeFakePort([rateLimited()]);
    const t1 = makeFakePort([rateLimited()]);
    const t2 = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [
        { label: "groq", model: "m1", port: t1.port },
        { label: "cerebras", model: "m2", port: t2.port },
      ],
      onEvent: (e) => ev.push(e), remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.error, undefined);
    strictEqual(r.failovers.length, 2);
    strictEqual(r.failovers[0]?.from, "nvidia:m");
    strictEqual(r.failovers[0]?.to, "groq:m1");
    strictEqual(r.failovers[1]?.from, "groq:m1");
    strictEqual(r.failovers[1]?.to, "cerebras:m2");
    const hops = ev.filter((e) => e.kind === "failover");
    strictEqual(hops.length, 2);
    ok(hops[0]?.text.includes("failing over to groq:m1"), hops[0]?.text);
    ok(hops[1]?.text.includes("failing over to cerebras:m2"), hops[1]?.text);
  });
  it("each target at most once: an exhausted chain ends with the remedy error", async () => {
    const primary = makeFakePort([rateLimited()]);
    const t1 = makeFakePort([rateLimited()]);
    const t2 = makeFakePort([rateLimited()]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [
        { label: "groq", model: "m1", port: t1.port },
        { label: "cerebras", model: "m2", port: t2.port },
      ],
      onEvent: () => { /* no-op */ }, remembered: listRules(cwd),
    });
    ok(r.error !== undefined);
    ok(r.error.includes("retry list exhausted"), r.error);
    ok(r.error.includes("--retry-wait"));
    ok(r.error.includes("--models/--failover"));
    strictEqual(primary.record.length, 1);
    strictEqual(t1.record.length, 1);
    strictEqual(t2.record.length, 1);
  });
  it("auth failure on the primary never hops (chain stays untouched)", async () => {
    const primary = makeFakePort([authFailure()]);
    const t1 = makeFakePort([rateLimited()]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [{ label: "groq", model: "m1", port: t1.port }],
      onEvent: () => { /* no-op */ }, remembered: listRules(cwd),
    });
    ok(r.error !== undefined && r.error.includes("invalid key"), r.error);
    strictEqual(r.failovers.length, 0);
    strictEqual(primary.record.length, 1);
    strictEqual(t1.record.length, 0);
  });
  it("rotation candidates are head-provider only: consumed before the hop, never after", async () => {
    const ev: LoopEvent[] = [];
    const primary = makeFakePort([rateLimited()]);
    const t1 = makeFakePort([rateLimited()]);
    const t2 = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "a", models: ["a", "b"], label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [
        { label: "groq", model: "m1", port: t1.port },
        { label: "cerebras", model: "m2", port: t2.port },
      ],
      onEvent: (e) => ev.push(e), remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    // Trail: rotate a→b (head, exhausted first), then hop, then hop.
    strictEqual(r.failovers.length, 3);
    strictEqual(r.failovers[0]?.from, "nvidia:a");
    strictEqual(r.failovers[0]?.to, "nvidia:b");
    strictEqual(r.failovers[1]?.from, "nvidia:b");
    strictEqual(r.failovers[1]?.to, "groq:m1");
    strictEqual(r.failovers[2]?.from, "groq:m1");
    strictEqual(r.failovers[2]?.to, "cerebras:m2");
    // Target ports only ever saw their own model — head models never replay.
    strictEqual(primary.record.map((c) => c.model).join(","), "a,b");
    strictEqual(t1.record.map((c) => c.model).join(","), "m1");
    strictEqual(t2.record.map((c) => c.model).join(","), "m2");
  });
  it("a 1-element chain is the old single --failover: one hop max", async () => {
    const primary = makeFakePort([rateLimited()]);
    const t1 = makeFakePort([rateLimited()]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [{ label: "groq", model: "m1", port: t1.port }],
      onEvent: () => { /* no-op */ }, remembered: listRules(cwd),
    });
    ok(r.error !== undefined && r.error.includes("retry list exhausted"), r.error);
    strictEqual(r.failovers.length, 1);
    strictEqual(r.failovers[0]?.to, "groq:m1");
    strictEqual(primary.record.length, 1);
    strictEqual(t1.record.length, 1);
  });
  it("a 1-element chain still succeeds on its single hop", async () => {
    const primary = makeFakePort([rateLimited()]);
    const t1 = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [{ label: "groq", model: "m1", port: t1.port }],
      onEvent: () => { /* no-op */ }, remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.error, undefined);
    strictEqual(r.failovers.length, 1);
    strictEqual(r.failovers[0]?.to, "groq:m1");
  });
});
