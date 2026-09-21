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
});
