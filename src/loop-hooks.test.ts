import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop } from "./loop.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { verifyChain } from "./audit.js";
import { readOutcomeRecords } from "./outcomes.js";
import type { HookDeps, HookPayload, LoadedHooks, SpawnResult } from "./hooks.js";

/**
 * Hook seams inside the loop, with a fake spawner (no real shells): the
 * Pre deny/warn split, memo-repeats firing nothing, Post seeing only
 * redacted bytes, and Stop observing every exit path — plus the additive
 * `hooks` tally on the outcome record.
 */

function stubAsk(_q: string): Promise<"yes" | "always" | "no"> {
  return Promise.resolve("yes");
}

const PASS_SPAWN: SpawnResult = { code: 0, stdout: "", stderr: "", timedOut: false };

function spawner(results: SpawnResult[], seen: { event: string; payload: HookPayload }[]): HookDeps {
  let i = 0;
  return {
    spawnHook: (_command, stdin, env) => {
      seen.push({ event: env["CODEWHIP_EVENT"] ?? "", payload: JSON.parse(stdin) as HookPayload });
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return Promise.resolve(r);
    },
  };
}

describe("hooks seams (loop)", () => {
  it("PreToolUse deny: the call is refused (hook:pretool, actor policy) and never executes; chain stays valid", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-deny-"));
    try {
      const seen: { event: string; payload: HookPayload }[] = [];
      const events: { kind: string; text: string }[] = [];
      const hooks: LoadedHooks = {
        defs: [{ event: "PreToolUse", match: "bash", command: "gate" }],
        errors: ["hooks.json: hook entry is not an object"],
      };
      const { port } = makeFakePort([
        toolTurn("bash", JSON.stringify({ command: "echo hi" })),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: (e) => events.push({ kind: e.kind, text: e.text }),
        hooks,
        hookDeps: spawner([{ code: 2, stdout: "", stderr: "blocked by gate", timedOut: false }], seen),
      });
      strictEqual(r.text, "done");
      // The bash call never executed: its only trace entry is the hook deny.
      const bashTrace = r.trace.filter((t) => t.tool === "bash");
      strictEqual(bashTrace.length, 1);
      strictEqual(bashTrace[0]?.policy, "deny:hook:pretool");
      strictEqual(bashTrace[0]?.actor, "policy");
      // The model sees the refusal with the hook's reason.
      const toolMsg = r.messages.filter((m) => m.role === "tool").at(-1);
      ok(toolMsg !== undefined && toolMsg.content.includes("held by PreToolUse hook: blocked by gate"), toolMsg?.content ?? "");
      // Run-start surfacing: armed banner + load errors, on the "hook" kind.
      ok(events.some((e) => e.kind === "hook" && e.text === "hooks armed: 1"), JSON.stringify(events));
      ok(events.some((e) => e.kind === "hook" && e.text.includes("hooks config:")), JSON.stringify(events));
      strictEqual(verifyChain(runCwd).valid, true);
      const rec = readOutcomeRecords(runCwd)[0];
      strictEqual(JSON.stringify(rec?.hooks), JSON.stringify({ fired: 1, denied: 1, warned: 0 }));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("PreToolUse warn (exit 1) proceeds: absence of signal is not an assertion", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-warn-"));
    try {
      const seen: { event: string; payload: HookPayload }[] = [];
      const events: string[] = [];
      const { port } = makeFakePort([
        toolTurn("bash", JSON.stringify({ command: "echo hi" })),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: (e) => events.push(e.text),
        hooks: { defs: [{ event: "PreToolUse", match: "*", command: "flaky" }], errors: [] },
        hookDeps: spawner([{ code: 1, stdout: "", stderr: "crashed", timedOut: false }], seen),
      });
      strictEqual(r.text, "done");
      ok(r.trace.some((t) => t.tool === "bash" && t.policy.startsWith("allow")), JSON.stringify(r.trace));
      ok(events.some((t) => t.includes("PreToolUse bash:")), events.join(" | "));
      const rec = readOutcomeRecords(runCwd)[0];
      // fired 1: only the Pre warn ran (this run config has no Stop hook).
      strictEqual(JSON.stringify(rec?.hooks), JSON.stringify({ fired: 1, denied: 0, warned: 1 }));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("memo repeats fire no hooks: Pre+Post run once per real exec, Stop once per run", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-memo-"));
    try {
      fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
      const seen: { event: string; payload: HookPayload }[] = [];
      const readArgs = JSON.stringify({ path: "f.txt" });
      const { port } = makeFakePort([
        toolTurn("read", readArgs),
        toolTurn("read", readArgs),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "read twice", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: () => undefined,
        hooks: {
          defs: [
            { event: "PreToolUse", match: "*", command: "p" },
            { event: "PostToolUse", match: "*", command: "q" },
            { event: "Stop", match: "*", command: "s" },
          ],
          errors: [],
        },
        hookDeps: spawner([PASS_SPAWN], seen),
      });
      strictEqual(r.repeatCalls, 1);
      // The second identical read was memo-served BEFORE the Pre seam: no spawn.
      strictEqual(seen.filter((s) => s.event === "PreToolUse").length, 1);
      strictEqual(seen.filter((s) => s.event === "PostToolUse").length, 1);
      strictEqual(seen.filter((s) => s.event === "Stop").length, 1);
      strictEqual(seen.find((s) => s.event === "Stop")?.payload.text, "done");
      const rec = readOutcomeRecords(runCwd)[0];
      strictEqual(JSON.stringify(rec?.hooks), JSON.stringify({ fired: 3, denied: 0, warned: 0 }));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("PostToolUse sees the redacted output — never the raw bytes", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-redact-"));
    try {
      fs.writeFileSync(path.join(runCwd, "leaky.txt"), "config: sk-abcdef123456\n");
      const seen: { event: string; payload: HookPayload }[] = [];
      const { port } = makeFakePort([
        toolTurn("read", JSON.stringify({ path: "leaky.txt" })),
        textTurn("done"),
      ]);
      await agentLoop({
        prompt: "read", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: () => undefined,
        hooks: { defs: [{ event: "PostToolUse", match: "read", command: "watch" }], errors: [] },
        hookDeps: spawner([PASS_SPAWN], seen),
      });
      const post = seen.find((s) => s.event === "PostToolUse");
      ok(post !== undefined, "expected a PostToolUse fire");
      ok(post.payload.result !== undefined && post.payload.result.includes("[redacted]"), post.payload.result ?? "");
      ok(!JSON.stringify(post.payload).includes("sk-abcdef123456"), "raw secret reached a hook payload");
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("Stop fires on the max-steps exit too, and a Stop deny only warns (observe-only)", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-stop-"));
    try {
      fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
      const seen: { event: string; payload: HookPayload }[] = [];
      const { port } = makeFakePort([
        toolTurn("read", JSON.stringify({ path: "f.txt" })),
        textTurn("never reached"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 1, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: () => undefined,
        hooks: { defs: [{ event: "Stop", match: "anything", command: "s" }], errors: [] },
        hookDeps: spawner([{ code: 2, stdout: "", stderr: "denied stop", timedOut: false }], seen),
      });
      strictEqual(r.text, "");
      strictEqual(seen.filter((s) => s.event === "Stop").length, 1);
      const rec = readOutcomeRecords(runCwd)[0];
      strictEqual(JSON.stringify(rec?.hooks), JSON.stringify({ fired: 1, denied: 0, warned: 1 }));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("PreToolUse additionalContext joins the result the model reads on its next turn", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-ctx-"));
    try {
      fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
      const seen: { event: string; payload: HookPayload }[] = [];
      const { port, record, messagesSeen } = makeFakePort([
        toolTurn("read", JSON.stringify({ path: "f.txt" })),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [], onEvent: () => undefined,
        hooks: { defs: [{ event: "PreToolUse", match: "read", command: "annotate" }], errors: [] },
        hookDeps: spawner([{ code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"this file is generated — do not edit"}}', stderr: "", timedOut: false }], seen),
      });
      strictEqual(r.text, "done");
      strictEqual(record.length, 2, "the hook's context must not cost an extra provider call");
      const toolMsg = r.messages.filter((m) => m.role === "tool").at(-1);
      ok(toolMsg !== undefined && toolMsg.content.includes("this file is generated — do not edit"), toolMsg?.content ?? "");
      ok(toolMsg !== undefined && toolMsg.content.includes("hello"), "the tool's own output must still be there");
      // The proof it worked: the SECOND call carried that text to the model.
      const second = JSON.stringify(messagesSeen[1] ?? []);
      ok(second.includes("this file is generated"), "context never reached the model");
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("continue:false stops the run mid-turn: the call is refused before executing, no further provider call is made, and the chain stays valid", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-stop-run-"));
    try {
      fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
      const seen: { event: string; payload: HookPayload }[] = [];
      const events: { kind: string; text: string }[] = [];
      const { port, record } = makeFakePort([
        toolTurn("read", JSON.stringify({ path: "f.txt" })),
        textTurn("must never run"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: (e) => events.push({ kind: e.kind, text: e.text }),
        hooks: { defs: [{ event: "PreToolUse", match: "read", command: "halt" }], errors: [] },
        hookDeps: spawner([{ code: 0, stdout: '{"continue":false,"stopReason":"the gate is closed"}', stderr: "", timedOut: false }], seen),
      });
      strictEqual(r.stopReason, "hook");
      strictEqual(r.text, "");
      strictEqual(record.length, 1, "a stopped run must not ask the model again");
      // The call was refused, never executed: one trace entry, and it is the refusal.
      const readTrace = r.trace.filter((t) => t.tool === "read");
      strictEqual(readTrace.length, 1);
      strictEqual(readTrace[0]?.policy, "deny:hook:stop");
      const toolMsg = r.messages.filter((m) => m.role === "tool").at(-1);
      ok(toolMsg?.content.includes("run stopped by PreToolUse hook: the gate is closed"), toolMsg?.content ?? "");
      ok(events.some((e) => e.kind === "hook" && e.text.includes("hook:stop")), JSON.stringify(events));
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("PostToolUse context appends in the same turn; Stop context is refused out loud; systemMessage never reaches a model", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-post-"));
    try {
      fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
      const seen: { event: string; payload: HookPayload }[] = [];
      const events: { kind: string; text: string }[] = [];
      const { port, messagesSeen } = makeFakePort([
        toolTurn("read", JSON.stringify({ path: "f.txt" })),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
        onEvent: (e) => events.push({ kind: e.kind, text: e.text }),
        hooks: {
          defs: [
            { event: "PostToolUse", match: "read", command: "watch" },
            { event: "Stop", match: "*", command: "wrap" },
          ],
          errors: [],
        },
        hookDeps: spawner([
          { code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"ci says: flaky"},"systemMessage":"for the human only"}', stderr: "", timedOut: false },
          { code: 0, stdout: '{"hookSpecificOutput":{"additionalContext":"too late for this"}}', stderr: "", timedOut: false },
        ], seen),
      });
      strictEqual(r.text, "done");
      const toolMsg = r.messages.filter((m) => m.role === "tool").at(-1);
      ok(toolMsg?.content.includes("ci says: flaky"), toolMsg?.content ?? "");
      ok(events.some((e) => e.kind === "hook" && e.text === "message: for the human only"), JSON.stringify(events));
      // Stop's context cannot reach a model that no longer exists — and says so.
      // The refusal wording now comes from hookPolicy (centralized) rather than
      // the Stop call site, so it names the same thing: no turn remains.
      ok(events.some((e) => e.text.includes("no model turn remaining")), JSON.stringify(events));
      const wire = JSON.stringify(messagesSeen);
      ok(!wire.includes("for the human only"), "a systemMessage was sent to a provider");
      ok(!wire.includes("too late for this"), "Stop context leaked into a transcript");
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("a lifecycle event cannot veto where its policy forbids: PostCompact ignores continue:false and additionalContext is refused by name", async () => {
    const { runHooksFor } = await import("./hooks.js");
    const spawner: HookDeps = {
      spawnHook: () => Promise.resolve({
        code: 0,
        stdout: '{"hookSpecificOutput":{"additionalContext":"sneak in"},"continue":false,"stopReason":"halt"}',
        stderr: "", timedOut: false,
      }),
    };
    const r = await runHooksFor([{ event: "PostCompact", match: "*", command: "c" }], "PostCompact", "",
      { event: "PostCompact", tool: "", seq: 0, runId: "r1", cwd: "/c" }, spawner);
    // Observe-only seam: neither the stop nor the context is honoured, and both
    // refusals are said out loud rather than dropped.
    strictEqual(r.stop, null);
    strictEqual(r.context, "");
    ok(r.reason.includes("compaction is the harness's own transcript edit"), r.reason);
    ok(r.reason.includes("continue: false"), r.reason);
  });

  it("hookPolicy is exhaustive over the 11 events and gates stops/context per seam", async () => {
    const { hookPolicy } = await import("./hooks.js");
    const events = ["PreToolUse", "PostToolUse", "Stop", "SessionStart", "UserPromptSubmit",
      "PreCompact", "PostCompact", "SubagentStart", "SubagentStop", "SessionEnd", "StopFailure"] as const;
    // Only pre-turn seams may stop a run.
    strictEqual(JSON.stringify(events.filter((e) => hookPolicy(e).stops)), JSON.stringify(["PreToolUse", "SessionStart", "UserPromptSubmit"]));
    // Context is honoured only where a model turn genuinely follows, and every
    // refusal carries its reason.
    for (const e of events) {
      const p = hookPolicy(e);
      if (p.context === "none") ok(p.contextRefusal.length > 0, `${e} must explain its refusal`);
    }
  });

  it("a tool name is refused as a match on a lifecycle event (only '*' is meaningful)", async () => {
    const { loadHooks } = await import("./hooks.js");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-hooks-lc-"));
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    fs.writeFileSync(path.join(cwd, ".codewhip", "hooks.json"), JSON.stringify([
      { event: "SessionEnd", match: "*", command: "ok" },
      { event: "SubagentStart", match: "bash", command: "nope" },
    ]));
    try {
      const r = loadHooks(cwd);
      strictEqual(r.defs.length, 1);
      strictEqual(r.defs[0]?.event, "SessionEnd");
      ok(r.errors.some((e) => e.includes("SubagentStart") && e.includes('match must be "*"')), r.errors.join(" | "));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("SessionStart continue:false stops BEFORE any provider call; SessionEnd still fires on the exit", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-lifecycle-"));
    try {
      const seen: { event: string }[] = [];
      const { port, record } = makeFakePort([textTurn("must never run")]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [], onEvent: () => undefined,
        hooks: {
          defs: [
            { event: "SessionStart", match: "*", command: "s" },
            { event: "SessionEnd", match: "*", command: "e" },
          ],
          errors: [],
        },
        hookDeps: {
          spawnHook: (_c, _stdin, env) => {
            const event = env["CODEWHIP_EVENT"] ?? "";
            seen.push({ event });
            const stop = event === "SessionStart" ? '{"continue":false,"stopReason":"policy gate"}' : "";
            return Promise.resolve({ code: 0, stdout: stop, stderr: "", timedOut: false });
          },
        },
      });
      // The stop was honoured before the first turn: no provider call, no text.
      strictEqual(record.length, 0, "a SessionStart stop must not spend a provider turn");
      strictEqual(r.stopReason, "hook");
      ok(seen.some((s) => s.event === "SessionStart"), JSON.stringify(seen));
      ok(seen.some((s) => s.event === "SessionEnd"), JSON.stringify(seen));
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("SessionStart additionalContext joins the user prompt the model reads", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-lcctx-"));
    try {
      const { port, messagesSeen } = makeFakePort([textTurn("done")]);
      await agentLoop({
        prompt: "fix it", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [], onEvent: () => undefined,
        hooks: { defs: [{ event: "SessionStart", match: "*", command: "s" }], errors: [] },
        hookDeps: {
          spawnHook: () => Promise.resolve({
            code: 0,
            stdout: '{"hookSpecificOutput":{"additionalContext":"repo convention: tabs, not spaces"}}',
            stderr: "", timedOut: false,
          }),
        },
      });
      const wire = JSON.stringify(messagesSeen[0] ?? []);
      ok(wire.includes("tabs, not spaces"), "SessionStart context never reached the model");
      ok(wire.includes("fix it"), "the original prompt must survive");
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("SubagentStart/SubagentStop fire around a delegate call", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-lhook-sub-"));
    try {
      const seen: { event: string; payload: HookPayload }[] = [];
      const { port } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "look around" })),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [], onEvent: () => undefined,
        hooks: {
          defs: [
            { event: "SubagentStart", match: "*", command: "s" },
            { event: "SubagentStop", match: "*", command: "e" },
          ],
          errors: [],
        },
        hookDeps: spawner([PASS_SPAWN], seen),
      });
      strictEqual(r.text, "done");
      strictEqual(seen.filter((s) => s.event === "SubagentStart").length, 1);
      // The child actually ran, so SubagentStop fires exactly once too.
      strictEqual(seen.filter((s) => s.event === "SubagentStop").length, 1);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });
});
