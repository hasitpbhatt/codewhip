import test from "node:test";
import assert from "node:assert/strict";
import { runGoalLoop, runVerify } from "./goal.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { agentLoop } from "./loop.js";
import type { UsageBucket } from "./outcomes.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type FakeLoop = (prompt: string, history: import("./provider-port.js").LoopMsg[], tokenBudget: number) => Promise<import("./loop.js").LoopResult>;

type FakeSpec = {
  text?: string;
  stopReason?: import("./loop.js").StopReason;
  toolCalls?: number;
  promptTokens?: number;
  completionTokens?: number;
  usageByModel?: UsageBucket[];
  cancelled?: boolean;
  error?: string;
  runId?: string;
  messages?: import("./provider-port.js").LoopMsg[];
};

/** Minimal fake agentLoop returning canned results in sequence. */
function makeFakeLoop(results: FakeSpec[]): { run: FakeLoop; calls: string[]; budgets: number[] } {
  const calls: string[] = [];
  const budgets: number[] = [];
  let i = 0;
  const run: FakeLoop = async (prompt, _history, tokenBudget) => {
    calls.push(prompt);
    budgets.push(tokenBudget);
    const spec = results[i] ?? results[results.length - 1];
    i++;
    const base: import("./loop.js").LoopResult = {
      text: spec.text ?? "done",
      runId: spec.runId ?? `run-${i}`,
      stopReason: spec.stopReason ?? "complete",
      promptTokens: spec.promptTokens ?? 10,
      completionTokens: spec.completionTokens ?? 5,
      usageByModel: spec.usageByModel ?? [],
      waitedMs: 0,
      failovers: [],
      steps: 1,
      toolCalls: spec.toolCalls ?? 0,
      trace: [],
      cancelled: spec.cancelled ?? false,
      checkpoints: 0,
      compact: { events: 0, truncated: 0, dropped: 0 },
      repeatCalls: 0,
      messages: spec.messages ?? [{ role: "user", content: prompt }, { role: "assistant", content: spec.text ?? "done" }],
      contextShape: { system: 0, tools: 0, ceiling: 0 },
    };
    if (spec.error !== undefined) base.error = spec.error;
    return base;
  };
  return { run, calls, budgets };
}

test("goal loop: single turn, complete without tools stops as complete", async () => {
  const { run } = makeFakeLoop([
    { text: "task finished", stopReason: "complete", toolCalls: 0, usageByModel: [{ label: "nvidia", model: "m", prompt: 10, completion: 5 }] },
  ]);
  const res = await runGoalLoop({
    goal: "fix the bug",
    prompt: "start",
    maxTurns: 5,
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 0,
  });
  assert.equal(res.turns, 1);
  assert.equal(res.stopReason, "complete");
  assert.equal(res.receipts.length, 1);
  assert.equal(res.receipts[0].turn, 1);
});

test("goal loop: verify command exiting 0 stops early", async () => {
  const { run, calls } = makeFakeLoop([
    { text: "in progress", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "more", stopReason: "complete", toolCalls: 1 },
    { text: "final", stopReason: "complete", toolCalls: 0 },
  ]);
  const res = await runGoalLoop({
    goal: "ship it",
    prompt: "go",
    maxTurns: 10,
    verifyCmd: process.platform === "win32" ? "exit 0" : "true",
    cwd: process.cwd(),
    agentLoop: run,
  });
  assert.equal(res.stopReason, "verify_passed");
  assert.equal(res.turns, 1);
  assert.equal(calls.length, 1);
});

test("goal loop: max-turns cap enforced", async () => {
  const { run } = makeFakeLoop([
    { text: "turn 1", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "turn 2", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "turn 3", stopReason: "complete", toolCalls: 1, usageByModel: [] },
  ]);
  const res = await runGoalLoop({
    goal: "loop forever",
    prompt: "start",
    maxTurns: 2,
    cwd: process.cwd(),
    agentLoop: run,
  });
  assert.equal(res.stopReason, "max_turns");
  assert.equal(res.turns, 2);
  assert.equal(res.receipts.length, 2);
});

test("goal loop: error in a turn stops the loop", async () => {
  const { run } = makeFakeLoop([
    { text: "ok", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { error: "provider 5xx", stopReason: "error", usageByModel: [] },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 10,
    cwd: process.cwd(),
    agentLoop: run,
  });
  assert.equal(res.stopReason, "error");
  assert.equal(res.turns, 2);
});

test("goal loop: cancellation stops the loop", async () => {
  const { run } = makeFakeLoop([
    { cancelled: true, stopReason: "error", usageByModel: [] },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 10,
    cwd: process.cwd(),
    agentLoop: run,
  });
  assert.equal(res.stopReason, "cancelled");
  assert.equal(res.turns, 1);
});

test("goal loop: goal is the first-turn prompt, subsequent turns reference it", async () => {
  const { run, calls } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t2", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t3", stopReason: "complete", toolCalls: 0 },
  ]);
  await runGoalLoop({
    goal: "MY_GOAL",
    prompt: "INITIAL",
    maxTurns: 3,
    cwd: process.cwd(),
    agentLoop: run,
  });
  assert.equal(calls[0], "INITIAL");
  assert.ok(calls[1]!.includes("MY_GOAL"), calls[1]);
  assert.ok(calls[2]!.includes("MY_GOAL"), calls[2]);
});

test("goal loop: verify command that fails continues the loop", async () => {
  const { run } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t2", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t3", stopReason: "complete", toolCalls: 1, usageByModel: [] },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 3,
    verifyCmd: process.platform === "win32" ? "exit 1" : "false",
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 0,
  });
  assert.equal(res.stopReason, "max_turns");
  assert.equal(res.turns, 3);
});

test("goal loop: interject steers the next turn, one receipt per turn", async () => {
  const { run, calls } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t2", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "done", stopReason: "complete", toolCalls: 0 },
  ]);
  let interjectCalled = false;
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 3,
    interject: true,
    readInterject: async () => {
      interjectCalled = true;
      return "steer here";
    },
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 0,
  });
  assert.equal(interjectCalled, true);
  assert.equal(res.stopReason, "complete");
  assert.equal(res.turns, 3);
  assert.equal(res.receipts.length, res.turns);
  assert.ok(calls[1]!.includes("steer here"), calls[1]);
});

test("goal loop: interject EOF continues autonomously", async () => {
  const { run } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t2", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t3", stopReason: "complete", toolCalls: 0 },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 3,
    interject: true,
    readInterject: async () => undefined,
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 0,
  });
  assert.equal(res.stopReason, "complete");
  assert.equal(res.turns, 3);
});

test("goal loop: maxBudgetUsd stops when metered cost is met", async () => {
  const { run } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [{ label: "nvidia", model: "m", prompt: 100, completion: 100 }] },
    { text: "t2", stopReason: "complete", toolCalls: 1, usageByModel: [{ label: "nvidia", model: "m", prompt: 100, completion: 100 }] },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 10,
    maxBudgetUsd: 0.000001,
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 1,
  });
  assert.equal(res.stopReason, "budget_met");
  assert.equal(res.turns, 1);
});

test("goal loop: maxBudgetUsd with unknown cost never pretends to meter", async () => {
  const { run } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [{ label: "x", model: "m", prompt: 10, completion: 5 }] },
    { text: "t2", stopReason: "complete", toolCalls: 0 },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 2,
    maxBudgetUsd: 0,
    cwd: process.cwd(),
    agentLoop: run,
    // No estimateCost injected, and one leg explicitly unpriced: the
    // ceiling cannot be evaluated, so the loop runs to completion
    // instead of stopping on a fiction.
    estimateCost: (buckets) => (buckets.length === 0 ? 0 : null),
  });
  assert.equal(res.stopReason, "complete");
  assert.equal(res.receipts[0].costUsd, null);
});

test("goal loop: receipts accumulate with per-turn cost", async () => {
  const { run } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [{ label: "nvidia", model: "m", prompt: 10, completion: 5 }] },
    { text: "t2", stopReason: "complete", toolCalls: 0, usageByModel: [{ label: "nvidia", model: "m", prompt: 8, completion: 3 }] },
  ]);
  let n = 0;
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 3,
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => { n += 1; return n; },
  });
  assert.equal(res.receipts.length, 2);
  assert.equal(res.receipts[0].turn, 1);
  assert.equal(res.receipts[1].turn, 2);
  assert.equal(res.receipts[0].costUsd, 1);
  assert.equal(res.receipts[1].costUsd, 3);
});

test("goal loop: unknown cost is null, never a fabricated 0", async () => {
  const { run } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [{ label: "x", model: "m", prompt: 10, completion: 5 }] },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 1,
    cwd: process.cwd(),
    agentLoop: run,
  });
  assert.equal(res.receipts[0].costUsd, null);
});

test("goal loop: invalid maxTurns throws before spending a turn", async () => {
  const { run, calls } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 0 },
  ]);
  await assert.rejects(
    () => runGoalLoop({ goal: "g", prompt: "p", maxTurns: 0, cwd: process.cwd(), agentLoop: run }),
    /maxTurns must be an integer 1..100/,
  );
  assert.equal(calls.length, 0);
});

test("goal loop: per-turn token budget is forwarded, default 250000", async () => {
  const { run, budgets } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 1, usageByModel: [] },
    { text: "t2", stopReason: "complete", toolCalls: 0 },
  ]);
  await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 2,
    tokenBudget: 1234,
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 0,
  });
  assert.deepEqual(budgets, [1234, 1234]);
  const { run: run2, budgets: budgets2 } = makeFakeLoop([
    { text: "t1", stopReason: "complete", toolCalls: 0 },
  ]);
  await runGoalLoop({ goal: "g", prompt: "p", maxTurns: 1, cwd: process.cwd(), agentLoop: run2, estimateCost: () => 0 });
  assert.deepEqual(budgets2, [250000]);
});

test("goal loop: finalResult is the last turn's LoopResult", async () => {
  const { run } = makeFakeLoop([
    { text: "first", stopReason: "complete", toolCalls: 1, runId: "r1" },
    { text: "last", stopReason: "complete", toolCalls: 0, runId: "r2" },
  ]);
  const res = await runGoalLoop({
    goal: "g",
    prompt: "p",
    maxTurns: 3,
    cwd: process.cwd(),
    agentLoop: run,
    estimateCost: () => 0,
  });
  assert.equal(res.finalResult.runId, "r2");
});

test("runVerify: exits 0 resolves true", async () => {
  const ok = await runVerify(process.platform === "win32" ? "exit 0" : "true", process.cwd());
  assert.equal(ok, true);
});

test("runVerify: non-zero exit resolves false", async () => {
  const ok = await runVerify(process.platform === "win32" ? "exit 3" : "false", process.cwd());
  assert.equal(ok, false);
});

test("runVerify: bad command resolves false, never throws", async () => {
  const ok = await runVerify(process.platform === "win32" ? "this-cmd-does-not-exist 2>&1 | Out-Null; exit 1" : "/nonexistent-cmd 2>/dev/null || true; exit 1", process.cwd());
  assert.equal(ok, false);
});

test("runVerify: aborted signal resolves false", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const ok = await runVerify("sleep 5", process.cwd(), ctrl.signal);
  assert.equal(ok, false);
});

test("goal loop over real agentLoop: compaction-safe goal in system prompt", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "goal-test-"));
  try {
    const { port } = makeFakePort([
      toolTurn("read", JSON.stringify({ path: "x.ts" }), { prompt: 20, completion: 5 }),
      textTurn("progress", { prompt: 20, completion: 5 }),
      textTurn("done", { prompt: 20, completion: 5 }),
    ]);
    const res = await runGoalLoop({
      goal: "fix x.ts",
      prompt: "start",
      maxTurns: 3,
      cwd: tmp,
      agentLoop: (prompt, history, tokenBudget) =>
        agentLoop({
          prompt,
          model: "m",
          label: "nvidia",
          cwd: tmp,
          maxSteps: 5,
          yolo: true,
          stdinIsTTY: false,
          port,
          tokenBudget,
          history,
        }),
    });
    assert.ok(res.turns >= 1);
    assert.equal(res.finalResult.text.length > 0, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
