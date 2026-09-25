import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { LoopResult, StopReason } from "./loop.js";
import {
  buildFailure,
  buildResult,
  emitEvent,
  emitInit,
  emitResult,
  headless,
  outputFormat,
  parseOutputFormat,
  MAX_STDIN_BYTES,
  readStdin,
  say,
  setOutputFormat,
  setWriteSink,
  writeResultText,
} from "./run-output.js";

/**
 * Captures through the module's own sink rather than monkeypatching
 * process.stdout — the test reporter writes to that same stream.
 */
function capture(): { out: string[]; err: string[]; stop: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  setWriteSink((stream, line) => {
    (stream === "stdout" ? out : err).push(line);
  });
  return {
    out,
    err,
    stop: () => {
      setWriteSink(null);
      setOutputFormat(null);
    },
  };
}

function loopResult(over: Partial<LoopResult> = {}): LoopResult {
  return {
    text: "done",
    runId: "run-1",
    stopReason: "complete",
    promptTokens: 100,
    completionTokens: 20,
    usageByModel: [{ label: "nvidia", model: "kimi-k3", prompt: 100, completion: 20 }],
    waitedMs: 0,
    failovers: [],
    steps: 3,
    toolCalls: 2,
    trace: [{ seq: 1, tool: "read", policy: "allow:default:read", actor: "policy", preview: "src/a.ts", subject: "src/a.ts" }],
    cancelled: false,
    checkpoints: 1,
    compact: { events: 0, truncated: 0, dropped: 0 },
    repeatCalls: 0,
    contextShape: { system: 900, tools: 700, ceiling: 60000 },
    messages: [],
    ...over,
  };
}

const facts = {
  provider: "nvidia",
  model: "kimi-k3",
  taskClass: "implement",
  durationMs: 1234,
  receipt: "receipt: 100 prompt + 20 completion tokens / nvidia:kimi-k3 / $0.0000 (nvidia free tier)",
  costUsd: 0,
  costNote: "$0.0000 (nvidia free tier)",
  tokenBudget: 250000,
};

test("parseOutputFormat accepts exactly the three documented formats", () => {
  assert.equal(parseOutputFormat("text"), "text");
  assert.equal(parseOutputFormat("json"), "json");
  assert.equal(parseOutputFormat("stream-json"), "stream-json");
  assert.equal(parseOutputFormat("yaml"), null);
  assert.equal(parseOutputFormat(""), null);
});

test("headless() tracks the mode and say() moves prose off stdout", () => {
  assert.equal(headless(), false);
  assert.equal(outputFormat(), null);

  setOutputFormat(null);
  const interactive = capture();
  say("banner");
  writeResultText("payload");
  assert.deepEqual(interactive.out, ["banner", "payload"]);
  assert.deepEqual(interactive.err, []);
  interactive.stop();

  for (const f of ["text", "json", "stream-json"] as const) {
    setOutputFormat(f);
    assert.equal(headless(), true, `${f} is headless`);
    const machine = capture();
    say("banner");
    assert.deepEqual(machine.out, [], `${f}: human prose leaked to stdout`);
    assert.deepEqual(machine.err, ["banner"]);
    machine.stop();
    assert.equal(outputFormat(), null, "capture.stop() resets the mode");
  }
});

test("stream-json writes NDJSON for init and events; other modes write nothing", () => {
  for (const f of ["text", "json"] as const) {
    setOutputFormat(f);
    const cap = capture();
    emitInit({ provider: "nvidia" });
    emitEvent({ kind: "tool", text: "run read src/a.ts" });
    cap.stop();
    assert.deepEqual([...cap.out, ...cap.err], [], `${f}: stream lines leaked`);
  }
  setOutputFormat("stream-json");
  const cap = capture();
  emitInit({ provider: "nvidia", model: "kimi-k3" });
  emitEvent({ kind: "policy", text: "token budget exhausted" });
  cap.stop();
  assert.deepEqual(cap.err, []);
  assert.equal(cap.out.length, 2);
  const init = JSON.parse(cap.out[0] as string) as Record<string, unknown>;
  const evt = JSON.parse(cap.out[1] as string) as Record<string, unknown>;
  assert.deepEqual([init.type, init.subtype, init.provider], ["system", "init", "nvidia"]);
  assert.deepEqual([evt.type, evt.kind, evt.text], ["event", "policy", "token budget exhausted"]);
});

test("buildResult maps every stop reason and keeps the receipt verbatim", () => {
  const want: Record<StopReason, string> = {
    complete: "success",
    max_steps: "error_max_steps",
    token_budget: "error_token_budget",
    cost_budget: "error_cost_budget",
    error: "error",
    cancelled: "cancelled",
  };
  for (const reason of Object.keys(want) as StopReason[]) {
    const p = buildResult(loopResult({ stopReason: reason }), facts);
    assert.equal(p.subtype, want[reason], reason);
    assert.equal(p.is_error, reason !== "complete", reason);
    assert.equal(p.receipt, facts.receipt);
    assert.equal(p.total_cost_usd, 0);
    assert.equal(p.num_turns, 3);
    assert.equal(p.run_id, "run-1");
    assert.equal(p.type, "result");
  }
  const err = buildResult(loopResult({ stopReason: "error", error: "provider failed" }), facts);
  assert.equal(err.error, "provider failed");
});

test("buildResult carries the governance fields a script needs", () => {
  const p = buildResult(loopResult({
    checkpoints: 2,
    failovers: [{ from: "nvidia", to: "kilo", reason: "429", waitedMs: 0, step: 2 }],
  }), {
    ...facts,
    maxBudgetUsd: 0.5,
    sessionId: "run-1",
    share: { path: ".codewhip/share-run-1.json", sha256: "abc" },
    polishGate: { pass: true, reason: "polish cost $0.0000 < $0.05" },
  });
  assert.equal(p.session_id, "run-1");
  assert.deepEqual(p.share, { path: ".codewhip/share-run-1.json", sha256: "abc" });
  assert.deepEqual(p.polish_gate, { pass: true, reason: "polish cost $0.0000 < $0.05" });
  assert.deepEqual(p.budget, { token_budget: 250000, max_budget_usd: 0.5 });
  assert.equal(p.checkpointed_files, 2);
  assert.equal(p.task_class, "implement");
  assert.deepEqual(p.usage, {
    prompt_tokens: 100,
    completion_tokens: 20,
    by_model: [{ label: "nvidia", model: "kimi-k3", prompt: 100, completion: 20 }],
  });
  assert.equal((p.trace as unknown[]).length, 1, "the redacted decision trail ships in the payload");
  assert.deepEqual(p.failovers, [{ from: "nvidia", to: "kilo", reason: "429", waitedMs: 0, step: 2 }]);
  // An estimated bucket stays marked as one — the meter never upgrades itself.
  const est = buildResult(loopResult({ usageByModel: [{ label: "nvidia", model: "m", prompt: 5, completion: 5, estimated: true }] }), facts);
  assert.equal((est.usage as { by_model: { estimated?: boolean }[] }).by_model[0]?.estimated, true);
  // An unpriced route reports null, never a fabricated 0.
  assert.equal(buildResult(loopResult(), { ...facts, costUsd: null, costNote: "cost untracked" }).total_cost_usd, null);
  const absent = buildResult(loopResult(), facts);
  for (const k of ["session_id", "share", "polish_gate", "error"]) {
    assert.ok(!(k in absent), `${k} should be omitted when unset`);
  }
});

test("emitResult prints one JSON document (json) or one final line (stream-json)", () => {
  const payload = buildResult(loopResult(), facts);

  setOutputFormat("json");
  const json = capture();
  emitResult(payload);
  json.stop();
  assert.deepEqual(json.err, []);
  assert.equal(json.out.length, 1, "exactly one document");
  assert.equal(JSON.parse(json.out[0] as string).run_id, "run-1");

  setOutputFormat("stream-json");
  const nd = capture();
  emitInit({ provider: "nvidia" });
  emitResult(payload);
  nd.stop();
  assert.equal(nd.out.length, 2);
  assert.equal(JSON.parse(nd.out[1] as string).type, "result");

  setOutputFormat("text");
  const txt = capture();
  emitResult(payload);
  txt.stop();
  assert.deepEqual(txt.out, [], "text mode never prints a JSON document");
});

test("buildFailure keeps the stdout envelope intact for a refused run", () => {
  setOutputFormat("json");
  const cap = capture();
  emitResult(buildFailure({
    provider: "nvidia",
    model: "kimi-k3",
    receipt: "receipt: 0 prompt + 0 completion tokens / nvidia:kimi-k3 / $0.0000 (nvidia free tier)",
    reason: "run refused before the loop started — see stderr",
  }));
  cap.stop();
  assert.equal(cap.out.length, 1);
  const p = JSON.parse(cap.out[0] as string) as Record<string, unknown>;
  assert.equal(p.type, "result");
  assert.equal(p.is_error, true);
  assert.equal(p.subtype, "error");
  assert.equal(p.run_id, null);
  assert.equal(p.result, "");
  assert.match(String(p.error), /see stderr/);
});

test("readStdin takes piped text to the end, trimmed", async () => {
  const r = await readStdin(Readable.from(["  review ", "the diff "]));
  assert.equal(r.text, "review the diff");
  assert.equal(r.error, undefined);
});

test("an empty pipe is nothing, not an error", async () => {
  assert.deepEqual(await readStdin(Readable.from([])), {});
  assert.deepEqual(await readStdin(Readable.from(["   "])), {});
});

test("a runaway cat is refused rather than swallowed as context", async () => {
  const huge = "x".repeat(MAX_STDIN_BYTES + 1);
  const r = await readStdin(Readable.from([huge]), 500);
  assert.match(String(r.error), /exceeds 1000000 bytes/);
});

test("opportunistic read gives up on a silent pipe and drops it", async () => {
  const silent = new Readable({ read() { /* never pushes */ } });
  const started = Date.now();
  assert.deepEqual(await readStdin(silent, 25), {});
  assert.ok(Date.now() - started < 1000, "must return on the window, not on the pipe");
  assert.equal(silent.destroyed, true, "an abandoned pipe must not keep the process alive");
});

test("opportunistic read still collects a pipe that speaks inside the window", async () => {
  const r = await readStdin(Readable.from(["patch body"]), 500);
  assert.equal(r.text, "patch body");
});
