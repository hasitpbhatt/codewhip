import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, withTimeout, type LoopEvent } from "./loop.js";
import { makeFakePort, textTurn, toolTurn, rateLimited, timeoutFailure, serverFailure, authFailure, otherFailure } from "./testkit/fakePort.js";
import { listRules } from "./remember-store.js";
import type { RememberedRule } from "./remember-store.js";
import { readAuditLog, verifyChain } from "./audit.js";
import { readOutcomeRecords } from "./outcomes.js";
import type { ToolResult } from "./tools/types.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-"));
function stubAsk(_q: string): Promise<"yes" | "always" | "no"> {
  return Promise.resolve("yes");
}

describe("loop", () => {
  it("records task_class to outcomes when the run was dispatched with one", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-class-"));
    const { port } = makeFakePort([textTurn("done")]);
    await agentLoop({
      prompt: "fix typo", model: "m", label: "nvidia", taskClass: "polish", cwd: runCwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: () => undefined, remembered: listRules(runCwd),
    });
    const recs = readOutcomeRecords(runCwd);
    strictEqual(recs.length, 1);
    strictEqual(recs[0]?.task_class, "polish");
  });
  it("omits task_class when the run carries none (old readers stay fine)", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-noclass-"));
    const { port } = makeFakePort([textTurn("done")]);
    await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: () => undefined, remembered: listRules(runCwd),
    });
    const recs = readOutcomeRecords(runCwd);
    strictEqual(recs.length, 1);
    strictEqual(recs[0]?.task_class, undefined);
    strictEqual(JSON.stringify(recs[0]).includes("task_class"), false);
  });  it("repeat guard: identical idempotent reads execute once and then nudge", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-repeat-"));
    const target = path.join(runCwd, "f.txt");
    fs.writeFileSync(target, "hello\n");
    const { TOOLS } = await import("./tools/registry.js");
    const realExec = TOOLS.read.exec;
    let execs = 0;
    TOOLS.read.exec = (ctx, a, s) => {
      execs += 1;
      return realExec(ctx, a, s);
    };
    try {
      const readArgs = JSON.stringify({ path: "f.txt" });
      const { port, messagesSeen } = makeFakePort([
        toolTurn("read", readArgs),
        toolTurn("read", readArgs),
        toolTurn("read", readArgs),
        toolTurn("read", readArgs),
        toolTurn("read", readArgs),
        textTurn("done"),
      ]);
      const ev: string[] = [];
      const r = await agentLoop({
        prompt: "read it", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 10, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk,
        onEvent: (e) => ev.push(e.text), remembered: listRules(runCwd),
      });
      strictEqual(r.text, "done");
      // Five identical calls, one real execution.
      strictEqual(execs, 1);
      strictEqual(r.repeatCalls, 4);
      strictEqual(r.trace.length, 5);
      ok(r.trace.every((t) => t.policy === "allow:loop:repeat-call" || t.policy === "allow:default:read:allow"));
      ok(ev.some((t) => t.includes("loop:repeat-call")), ev.join(" | "));
      // The nudge replaces the body once the model is clearly stuck.
      const lastTool = messagesSeen[5]?.filter((m) => m.role === "tool").at(-1);
      ok(lastTool !== undefined && lastTool.content.includes("cannot change"), lastTool?.content ?? "");
      const v = verifyChain(runCwd);
      strictEqual(v.valid, true);
    } finally {
      TOOLS.read.exec = realExec;
    }
  });
  it("repeat guard: an intervening edit invalidates the memo", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-repeat-inv-"));
    fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
    const { TOOLS } = await import("./tools/registry.js");
    const realExec = TOOLS.read.exec;
    let execs = 0;
    TOOLS.read.exec = (ctx, a, s) => {
      execs += 1;
      return realExec(ctx, a, s);
    };
    try {
      const readArgs = JSON.stringify({ path: "f.txt" });
      const { port, messagesSeen } = makeFakePort([
        toolTurn("read", readArgs),
        toolTurn("read", readArgs),
        toolTurn("edit", JSON.stringify({ path: "f.txt", oldString: "hello", newString: "bye" })),
        toolTurn("read", readArgs),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "edit it", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 10, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(runCwd),
      });
      strictEqual(r.text, "done");
      // read, repeated read (memo), edit clears, read again re-executes.
      strictEqual(execs, 2);
      strictEqual(r.repeatCalls, 1);
      const lastTool = messagesSeen[4]?.filter((m) => m.role === "tool").at(-1);
      ok(lastTool !== undefined && lastTool.content.includes("bye"), lastTool?.content ?? "");
    } finally {
      TOOLS.read.exec = realExec;
    }
  });
  it("repeat guard: a denied call is never memoized as a standing denial", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-repeat-deny-"));
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "rm -rf /" })),
      toolTurn("bash", JSON.stringify({ command: "rm -rf /" })),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(runCwd),
    });
    // Both denials land as denials (bash is not idempotent — the guard skips it).
    strictEqual(r.repeatCalls, 0);
    strictEqual(r.trace.length, 2);
    ok(r.trace.every((t) => t.policy === "deny:denylist:rm -rf /"), JSON.stringify(r.trace.map((t) => t.policy)));
  });
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
  it("a human-approved ask records its shape (immunity positive sample)", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-approve-"));
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hi" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: async () => "yes", remembered: listRules(runCwd),
    });
    const raw = fs.readFileSync(path.join(runCwd, ".codewhip", "outcomes.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      tool_calls: { decision: string; ruleId: string; shape?: string }[];
    };
    strictEqual(last.tool_calls[0]?.decision, "allow");
    strictEqual(last.tool_calls[0]?.shape, "echo hi *");
  });
  it("a yolo grant records no shape (no fresh human bit)", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-yolo-"));
    const { port } = makeFakePort([
      toolTurn("bash", JSON.stringify({ command: "echo hi" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: async () => "yes", remembered: listRules(runCwd),
    });
    const raw = fs.readFileSync(path.join(runCwd, ".codewhip", "outcomes.jsonl"), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const last = JSON.parse(lines[lines.length - 1] as string) as {
      tool_calls: { decision: string; shape?: string }[];
    };
    strictEqual(last.tool_calls[0]?.decision, "allow");
    strictEqual(last.tool_calls[0]?.shape, undefined);
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
  it("takePendingSwitch swaps label/model/port at the next turn boundary (TUI /model)", async () => {
    const readArgs = JSON.stringify({ path: "f.txt" });
    const { port, record } = makeFakePort([toolTurn("read", readArgs), textTurn("done")]);
    let armed = false;
    const r = await agentLoop({
      prompt: "hi", model: "a", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      remembered: listRules(cwd),
      takePendingSwitch: () => {
        // Arm only after the first provider call: turn 1 runs on the head
        // model, and the switch applies at the next boundary (turn 2).
        if (record.length === 0 || armed) return null;
        armed = true;
        return { label: "other", model: "z", port };
      },
    });
    strictEqual(r.text, "done");
    strictEqual(r.error, undefined);
    strictEqual(record.map((c) => c.model).join(","), "a,z");
    // Receipts split usage per model, so the switch is visible in the mix.
    ok(r.usageByModel.some((b) => b.label === "other" && b.model === "z"), JSON.stringify(r.usageByModel));
    ok(r.usageByModel.some((b) => b.label === "nvidia" && b.model === "a"), JSON.stringify(r.usageByModel));
  });

  it("after a live /model switch, head-provider rotation does NOT fire on the new port", async () => {
    // The bug: rotation candidates were bare model ids resolved against
    // whatever port `current` held — after /model groq, a 429 sent the head
    // provider's next model id to groq and the run died terminally.
    const { port, record } = makeFakePort([
      toolTurn("read", JSON.stringify({ path: "f.txt" })),
      rateLimited(),
      rateLimited(),
      textTurn("done"),
    ]);
    let armed = false;
    const r = await agentLoop({
      prompt: "hi", model: "a", models: ["a", "b"], label: "kilo", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      remembered: listRules(cwd),
      takePendingSwitch: () => {
        if (record.length === 0 || armed) return null;
        armed = true;
        return { label: "groq", model: "z", port };
      },
    });
    // The switch applied, the 429 on the new provider found NO rotation
    // candidates (rotation is head-provider-gated) and no failover chain —
    // so the run ends naming the failed switch, never sending model "b" (a
    // kilo id) to the groq port. The record proves the foreign id never dialed.
    ok(r.error !== undefined, "expected terminal error");
    ok(r.error.includes("live /model switch to groq:z failed terminally"), r.error);
    ok(!record.some((c) => c.model === "b" && record.indexOf(c) > 0), `foreign model id dialed: ${JSON.stringify(record.map((c) => c.model))}`);
  });

  it("a terminally failed turn that had a switch applied says so", async () => {
    const { port, record } = makeFakePort([toolTurn("read", JSON.stringify({ path: "f.txt" })), authFailure()]);
    let armed = false;
    const r = await agentLoop({
      prompt: "hi", model: "a", label: "kilo", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      remembered: listRules(cwd),
      takePendingSwitch: () => {
        // Arms at the second turn boundary: the auth-failing call is the
        // first call dialed on the switched target.
        if (record.length === 0 || armed) return null;
        armed = true;
        return { label: "groq", model: "z", port };
      },
    });
    ok(r.error !== undefined);
    ok(r.error.includes("live /model switch to groq:z failed terminally"), r.error);
  });

  it("a null takePendingSwitch never disturbs the run", async () => {
    const { port, record } = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "a", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      remembered: listRules(cwd),
      takePendingSwitch: () => null,
    });
    strictEqual(r.text, "done");
    strictEqual(record.map((c) => c.model).join(","), "a");
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
  it("an upstream 5xx rotates candidates like a 429 (a 503 must not strand the chain)", async () => {
    // Regression 2026-09-14: `server` is a rotatable class precisely so a free
    // tier in a maintenance window does not end the run.
    const ev: string[] = [];
    const { port, record } = makeFakePort([serverFailure(503), textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "a", models: ["a", "b"], label: "empero", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.error, undefined);
    ok(ev.some((t) => t.includes("server error") && t.includes("rotating")), ev.join(" | "));
    strictEqual(record.map((c) => c.model).join(","), "a,b");
  });
  it("an upstream 5xx hops the provider chain, not just the model list", async () => {
    const primary = makeFakePort([serverFailure(503)]);
    const t1 = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "empero", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [{ label: "pollinations", model: "mistral", port: t1.port }],
      onEvent: () => { /* no-op */ }, remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.failovers.length, 1);
    strictEqual(r.failovers[0]?.from, "empero:m");
    strictEqual(r.failovers[0]?.to, "pollinations:mistral");
  });
  it("quietFailover records the hop but prints nothing (silent backend)", async () => {
    const ev: LoopEvent[] = [];
    const primary = makeFakePort([serverFailure(503)]);
    const t1 = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "empero", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [{ label: "pollinations", model: "mistral", port: t1.port }],
      quietFailover: true,
      onEvent: (e) => ev.push(e), remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    // The hop stays on the audited record (from/to/reason)…
    strictEqual(r.failovers.length, 1);
    strictEqual(r.failovers[0]?.from, "empero:m");
    strictEqual(r.failovers[0]?.to, "pollinations:mistral");
    ok(r.failovers[0]?.reason.includes("503") === true, r.failovers[0]?.reason);
    // …but no failover/retry chatter reaches the terminal.
    strictEqual(ev.filter((e) => e.kind === "failover" || e.kind === "retry").length, 0);
  });
  it("a terminal failure still never hops (the rotatable class is not a blanket)", async () => {
    const primary = makeFakePort([otherFailure()]);
    const t1 = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: false,
      stdinIsTTY: true, port: primary.port,
      failovers: [{ label: "groq", model: "m1", port: t1.port }],
      onEvent: () => { /* no-op */ }, remembered: listRules(cwd),
    });
    ok(r.error !== undefined && r.error.includes("something else"), `error was: ${r.error}`);
    strictEqual(r.failovers.length, 0);
    strictEqual(t1.record.length, 0);
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
  it("plan mode: todo stays allowed — planning is the task there", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-plan-todo-"));
    const { port } = makeFakePort([
      toolTurn("todo", JSON.stringify({ action: "replace", items: [{ id: "1", text: "sketch the change", status: "in_progress" }] })),
      textTurn("plan ready"),
    ]);
    const r = await agentLoop({
      prompt: "plan this", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, planMode: true, remembered: [],
    });
    strictEqual(r.text, "plan ready");
    strictEqual(r.trace[0]?.policy, "allow:default:todo:allow");
    ok(fs.existsSync(path.join(runCwd, ".codewhip", "todos.json")));
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
  it("compaction fires mid-run with an honest event when the transcript crosses the ceiling", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-compact-"));
    for (const f of ["a.txt", "b.txt", "c.txt"]) {
      fs.writeFileSync(path.join(runCwd, f), "x".repeat(8000));
    }
    const ev: string[] = [];
    const { port } = makeFakePort([
      toolTurn("read", JSON.stringify({ path: "a.txt" }), { prompt: 10, completion: 0 }),
      toolTurn("read", JSON.stringify({ path: "b.txt" }), { prompt: 10, completion: 0 }),
      toolTurn("read", JSON.stringify({ path: "c.txt" }), { prompt: 10, completion: 0 }),
      textTurn("done"),
    ]);
    // Force the ceiling low: each read's (capped) 4000-char output dwarfs it.
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 10, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, compactTokens: 100,
      onEvent: (e) => ev.push(e.text), remembered: listRules(runCwd),
    });
    strictEqual(r.error, undefined);
    strictEqual(r.text, "done");
    ok(r.compact.events >= 1, JSON.stringify(r.compact));
    ok(ev.some((t) => t.includes("compacted:") && t.includes("est.")), ev.join(" "));
  });
  it("compactTokens: 0 disables compaction entirely", async () => {
    const ev: string[] = [];
    const { port } = makeFakePort([
      toolTurn("read", JSON.stringify({ path: "a.txt" })),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 10, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, compactTokens: 0,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
    });
    strictEqual(r.error, undefined);
    strictEqual(r.compact.events, 0);
    ok(!ev.some((t) => t.includes("compacted:")));
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
  it("stopReason distinguishes complete, max_steps and token_budget", async () => {
    const done = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port: makeFakePort([textTurn("all done")]).port,
      onEvent: () => undefined, remembered: listRules(cwd),
    });
    strictEqual(done.stopReason, "complete");
    strictEqual(done.error, undefined);

    // A model that keeps asking for work never settles: the step cap ends it.
    const spinning = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 2, yolo: true,
      stdinIsTTY: true,
      port: makeFakePort([
        toolTurn("read", '{"path":"package.json"}'),
        toolTurn("read", '{"path":"package.json"}'),
        toolTurn("read", '{"path":"package.json"}'),
      ]).port,
      onEvent: () => undefined, remembered: listRules(cwd),
    });
    strictEqual(spinning.stopReason, "max_steps");
    strictEqual(spinning.steps, 2);

    const capped = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true,
      port: makeFakePort([textTurn("one", { prompt: 300000, completion: 0 })]).port,
      onEvent: () => undefined, remembered: listRules(cwd),
      tokenBudget: 250000,
    });
    strictEqual(capped.stopReason, "token_budget");
  });
  it("costCheck stops the run on a dollar ceiling the surface computes", async () => {
    const ev: string[] = [];
    const turns = [textTurn("one", { prompt: 1000, completion: 500 }), textTurn("two")];
    const r = await agentLoop({
      prompt: "hi", model: "paid", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port: makeFakePort(turns).port,
      onEvent: (e) => ev.push(e.text), remembered: listRules(cwd),
      costCheck: (buckets) => {
        const tokens = buckets.reduce((s, b) => s + b.prompt + b.completion, 0);
        return tokens > 100
          ? { stopReason: "cost_budget" as const, message: "cost budget exhausted ($0.02/$0.01) — partial transcript kept" }
          : null;
      },
    });
    strictEqual(r.stopReason, "cost_budget");
    ok(r.error !== undefined && r.error.includes("cost budget exhausted"));
    ok(ev.some((t) => t.includes("cost budget exhausted")));
    // The ceiling is checked after each billed turn, so the run stopped before
    // the second turn could run — the transcript is partial, not empty.
    strictEqual(r.steps, 1);
  });
  it("costCheck returning null lets the run finish normally", async () => {
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port: makeFakePort([textTurn("done")]).port,
      onEvent: () => undefined, remembered: listRules(cwd),
      costCheck: () => null,
    });
    strictEqual(r.stopReason, "complete");
    strictEqual(r.error, undefined);
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
    ok(r.error !== undefined && r.error.includes("invalid key"), `error was: ${r.error}`);
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
    ok(r.error !== undefined && r.error.includes("retry list exhausted"), `error was: ${r.error}`);
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
  it("history seeds between system and the new user prompt (system → history → user)", async () => {
    const { port, messagesSeen } = makeFakePort([textTurn("done")]);
    const history = [
      { role: "user" as const, content: "old q" },
      { role: "assistant" as const, content: "old a" },
    ];
    const r = await agentLoop({
      prompt: "new q", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd), history,
    });
    strictEqual(r.text, "done");
    const first = messagesSeen[0] ?? [];
    // messagesSeen holds the live array reference (the loop pushes the reply
    // after the call), so assert the seed prefix, not the final length.
    ok(first.length >= 4, JSON.stringify(first.length));
    strictEqual(first[0]?.role, "system");
    strictEqual(first[1]?.content, "old q");
    strictEqual(first[2]?.content, "old a");
    strictEqual(first[3]?.content, "new q");
  });
  it("result.messages carries the transcript on success", async () => {
    const { port } = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    ok(r.messages.length >= 3, JSON.stringify(r.messages.length));
    strictEqual(r.messages[0]?.role, "system");
    strictEqual(r.messages[1]?.role, "user");
    strictEqual(r.messages[r.messages.length - 1]?.role, "assistant");
  });
  it("result.messages carries the partial transcript on a forced-error path", async () => {
    const { port } = makeFakePort([otherFailure()]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    ok(r.error !== undefined, "expected an error");
    ok(r.messages.length >= 2, JSON.stringify(r.messages.length));
    strictEqual(r.messages[0]?.role, "system");
    strictEqual(r.messages[1]?.role, "user");
  });
});
