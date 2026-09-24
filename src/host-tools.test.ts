import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop, type LoopEvent } from "./loop.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { listRules } from "./remember-store.js";
import type { HostToolDef, ToolExec } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";

/**
 * Host-provided tools — the `tool()` half of the public programmatic entry
 * (`src/sdk.ts`). The rule under test is that a caller function inherits the
 * fail-closed defaults, not a private path around them: no policy row of its
 * own, never remembered, never memoized, refused by plan mode and refused in a
 * subagent, and governed by a compiled `deny <tool>:<shape>` like any builtin.
 */

function specFor(name: string): { name: string; description: string; parameters: unknown } {
  return { name, description: "host tool", parameters: { type: "object", properties: {} } };
}
function host(name: string, exec: ToolExec, timeoutMs = 5000): HostToolDef {
  return { name, spec: specFor(name), timeoutMs, exec };
}
function okOutput(out: string): Promise<ToolResult> {
  return Promise.resolve({ ok: true, output: out });
}
function runCwd(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
const stubAsk = (): Promise<"yes"> => Promise.resolve("yes");

describe("host-provided tools", () => {
  it("is advertised to the model and its output reaches the transcript", async () => {
    const dir = runCwd("codewhip-host-run-");
    let calls = 0;
    const { port, record } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(dir),
      customTools: [host("lookup_bug", () => {
        calls += 1;
        return okOutput("NPE at line 7");
      })],
    });
    strictEqual(record[0]?.toolCount, 13, "twelve builtins plus the host tool");
    strictEqual(calls, 1);
    strictEqual(r.messages.find((m) => m.role === "tool")?.content, "NPE at line 7");
    strictEqual(r.error, undefined);
  });

  it("answers its ask through the human rung, with the graded subject in hand", async () => {
    const dir = runCwd("codewhip-host-ask-");
    const seen: Array<{ tool: string; subject: string; ruleId: string }> = [];
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, remembered: listRules(dir),
      askUser: (_q, ctx) => {
        seen.push({ tool: ctx?.tool ?? "", subject: ctx?.subject ?? "", ruleId: ctx?.ruleId ?? "" });
        return Promise.resolve("yes");
      },
      customTools: [host("lookup_bug", () => okOutput("NPE at line 7"))],
    });
    strictEqual(seen.length, 1);
    strictEqual(seen[0]?.tool, "lookup_bug");
    strictEqual(seen[0]?.subject, '{"id":7}', "the same value the verdict was graded against");
    strictEqual(seen[0]?.ruleId, "default:host-tool:ask");
    strictEqual(r.trace.find((t) => t.tool === "lookup_bug")?.policy, "allow:default:host-tool:ask");
    strictEqual(r.trace.find((t) => t.tool === "lookup_bug")?.actor, "human");
  });

  it("asks again on the next identical call — a host grant is never remembered", async () => {
    const dir = runCwd("codewhip-host-nomem-");
    let asks = 0;
    let execs = 0;
    const { port } = makeFakePort([
      toolTurn("lookup_bug", '{"id":7}'), toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed"),
    ]);
    await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, remembered: listRules(dir),
      askUser: () => {
        asks += 1;
        return Promise.resolve("always");
      },
      customTools: [host("lookup_bug", () => {
        execs += 1;
        return okOutput("NPE at line 7");
      })],
    });
    strictEqual(asks, 2, "the `always` answer bought nothing for the second call");
    strictEqual(execs, 2, "and no memo covers a body the harness cannot reason about");
    strictEqual(listRules(dir).length, 0, "nothing was written to remembered.jsonl");
  });

  it("is held and denied when nobody can answer", async () => {
    const dir = runCwd("codewhip-host-held-");
    let execs = 0;
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: false,
      stdinIsTTY: false, port, remembered: listRules(dir),
      customTools: [host("lookup_bug", () => {
        execs += 1;
        return okOutput("nope");
      })],
    });
    strictEqual(execs, 0);
    ok(r.messages.find((m) => m.role === "tool")?.content.includes("held for approval"), "held, not run");
  });

  it("--yolo answers a host ask the way it answers any other", async () => {
    const dir = runCwd("codewhip-host-yolo-");
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: true,
      stdinIsTTY: false, port, remembered: listRules(dir),
      customTools: [host("lookup_bug", () => okOutput("NPE at line 7"))],
    });
    strictEqual(r.trace.find((t) => t.tool === "lookup_bug")?.actor, "yolo");
  });

  it("plan mode refuses it: the harness cannot see what the body does", async () => {
    const dir = runCwd("codewhip-host-plan-");
    let execs = 0;
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("the plan")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(dir), planMode: true,
      customTools: [host("lookup_bug", () => {
        execs += 1;
        return okOutput("nope");
      })],
    });
    strictEqual(execs, 0);
    strictEqual(r.trace.find((t) => t.tool === "lookup_bug")?.policy, "deny:plan:read-only");
  });

  it("a subagent is never offered one, and refuses it if called anyway", async () => {
    const dir = runCwd("codewhip-host-child-");
    let execs = 0;
    const { port, record } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("child done")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(dir), depth: 1,
      customTools: [host("lookup_bug", () => {
        execs += 1;
        return okOutput("nope");
      })],
    });
    strictEqual(record[0]?.toolCount, 2, "a child sees read+search only");
    strictEqual(execs, 0);
    strictEqual(r.trace.find((t) => t.tool === "lookup_bug")?.policy, "deny:loop:child-host-tool");
  });

  it("a policy.md deny line governs it by name and shape", async () => {
    const dir = runCwd("codewhip-host-policy-");
    fs.writeFileSync(path.join(dir, "policy.md"), 'deny lookup_bug:{"id":*\n', "utf8");
    let execs = 0;
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(dir),
      customTools: [host("lookup_bug", () => {
        execs += 1;
        return okOutput("nope");
      })],
    });
    strictEqual(execs, 0, "not even --yolo outranks a compiled deny");
    ok(
      r.trace.find((t) => t.tool === "lookup_bug")?.policy.startsWith("deny:policy.md:deny:lookup_bug:"),
      "refused with the rule pointer a reviewer can read back"
    );
  });

  it("drops an unusable definition with its cause instead of advertising it", async () => {
    const dir = runCwd("codewhip-host-bad-");
    const events: LoopEvent[] = [];
    const { port, record } = makeFakePort([toolTurn("Read", "{}"), textTurn("fixed")]);
    const r = await agentLoop({
      prompt: "hi", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(dir),
      onEvent: (e) => events.push(e),
      customTools: [
        { name: "Read", spec: specFor("Read"), timeoutMs: 5000, exec: () => okOutput("shadow") },
        { name: "no_timeout", spec: specFor("no_timeout"), timeoutMs: 0, exec: () => okOutput("x") },
      ],
    });
    strictEqual(record[0]?.toolCount, 12, "neither bad definition reached the spec list");
    strictEqual(events.filter((e) => e.text.startsWith("host tool refused")).length, 2);
    strictEqual(r.trace.find((t) => t.tool === "Read")?.policy, "deny:loop:bad-call");
  });
});
