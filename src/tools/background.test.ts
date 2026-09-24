import { describe, it, after } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runInBackground, taskOutput, taskStop } from "./background.js";
import { isRunInBackgroundArgs, isTaskOutputArgs, isTaskStopArgs } from "./background-tools.js";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-bg-"));
const ctx = { cwd } as Parameters<typeof runInBackground>[0];

// Every spawned child holds stdio pipes into this process: a task that is
// still alive at file end pins the event loop until its 120s default timeout
// kills it (that was the whole-suite 124s hang). Track all started ids and
// stop leftovers in after() so no single test can reintroduce it.
const started: string[] = [];
function track(output: string): void {
  const m = output.match(/task_\d+/);
  if (m !== null && !started.includes(m[0])) started.push(m[0]);
}

after(async () => {
  for (const id of started) {
    await taskStop(ctx, { id });
  }
});

describe("background arg guards", () => {
  it("accepts a command", () => {
    strictEqual(isRunInBackgroundArgs({ command: "echo hi" }), true);
  });
  it("rejects missing command", () => {
    strictEqual(isRunInBackgroundArgs({}), false);
  });
  it("accepts task_output id", () => {
    strictEqual(isTaskOutputArgs({ id: "task_1" }), true);
  });
  it("rejects task_output without id", () => {
    strictEqual(isTaskOutputArgs({}), false);
  });
  it("accepts task_stop id", () => {
    strictEqual(isTaskStopArgs({ id: "task_1" }), true);
  });
});

describe("run_in_background", () => {
  it("returns a task id immediately for a long-running command", async () => {
    const r = await runInBackground(ctx, { command: "ping -n 99999 127.0.0.1" });
    strictEqual(r.ok, true);
    ok(r.output.startsWith("started background task task_"), r.output);
    track(r.output);
    // Stop it now: an immortal child left running pins the test process until
    // its 120s default-timeout kill fires (after() is the backstop).
    const id = r.output.match(/task_\d+/)?.[0] ?? "";
    const stop = await taskStop(ctx, { id });
    strictEqual(stop.ok, true);
  });

  it("runs to completion and reports output via task_output", async () => {
    const start = await runInBackground(ctx, { command: "echo hello-from-bg", waitMs: 5000 });
    strictEqual(start.ok, true);
    track(start.output);
    const id = start.output.match(/task_\d+/)?.[0] ?? start.output.slice(start.output.indexOf("task_")).split(" ")[0];
    const out = await taskOutput(ctx, { id });
    strictEqual(out.ok, true);
    ok(out.output.includes("hello-from-bg"), out.output);
    ok(out.output.includes("exited 0") || out.output.includes("[completed"), out.output);
  });

  it("applies the bash denylist in background mode", async () => {
    const r = await runInBackground(ctx, { command: "rm -rf /" });
    strictEqual(r.ok, false);
    ok(r.output.includes("denylist"), r.output);
  });

  it("refuses shell chaining", async () => {
    const r = await runInBackground(ctx, { command: "echo a & echo b" });
    strictEqual(r.ok, false);
  });

  it("task_output rejects unknown ids", async () => {
    const r = await taskOutput(ctx, { id: "task_99999" });
    strictEqual(r.ok, false);
    ok(r.output.includes("unknown task"), r.output);
  });

  it("task_stop kills a running task", async () => {
    const start = await runInBackground(ctx, { command: "ping -n 30 127.0.0.1" });
    strictEqual(start.ok, true);
    track(start.output);
    const id = start.output.match(/task_\d+/)?.[0] ?? start.output.slice(start.output.indexOf("task_")).split(" ")[0];
    const stop = await taskStop(ctx, { id });
    strictEqual(stop.ok, true);
    // The old message claimed "sent SIGTERM" — a POSIX lie on win32, where a
    // bare kill orphaned the whole descendant tree. The stop is a tree kill now.
    ok(stop.output.includes("process tree killed"), stop.output);
    // After a beat, the task should report killed.
    await new Promise((r) => setTimeout(() => r(undefined), 200));
    const out = await taskOutput(ctx, { id });
    ok(out.output.includes("killed") || out.output.includes("running"), out.output);
  });

  it("task_stop rejects unknown ids", async () => {
    const r = await taskStop(ctx, { id: "task_99999" });
    strictEqual(r.ok, false);
  });
});
