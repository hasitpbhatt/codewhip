import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { listEvalTasks, runEval } from "./eval.js";
import { appendEvalRecord, readEvalRecords, summarizeEval, type EvalRecord } from "./eval-store.js";
import { readOutcomeRecords } from "./outcomes.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";

function tempCwd(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-evaltest-"));
}

describe("eval-store", () => {
  it("round-trips records through eval.jsonl", () => {
    const cwd = tempCwd();
    try {
      const rec: EvalRecord = {
        v: 1, ts: "2026-09-18T00:00:00.000Z", task: "t1", class: "polish",
        pass: true, runId: "abcdefgh1234", provider: "p", model: "m",
        promptTokens: 10, completionTokens: 5, steps: 2, failovers: 0,
      };
      ok(appendEvalRecord(cwd, rec));
      const rows = readEvalRecords(cwd);
      strictEqual(rows.length, 1);
      strictEqual(rows[0]?.task, "t1");
      strictEqual(rows[0]?.pass, true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("skips malformed lines instead of failing the whole file", () => {
    const cwd = tempCwd();
    try {
      fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
      const good = JSON.stringify({
        v: 1, ts: "t", task: "x", class: "implement", pass: false, runId: "r",
        provider: "p", model: "m", promptTokens: 1, completionTokens: 1, steps: 1, failovers: 0,
      });
      fs.writeFileSync(path.join(cwd, ".codewhip", "eval.jsonl"), `not json\n{"v":2}\n${good}\n`);
      const rows = readEvalRecords(cwd);
      strictEqual(rows.length, 1);
      strictEqual(rows[0]?.task, "x");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("summarizes per class with latest-per-task-wins", () => {
    const mk = (task: string, cls: "polish" | "implement", pass: boolean, ts: string): EvalRecord => ({
      v: 1, ts, task, class: cls, pass, runId: "r", provider: "p", model: "m",
      promptTokens: 0, completionTokens: 0, steps: 1, failovers: 0,
    });
    const s = summarizeEval([
      mk("a", "polish", false, "2026-01-01"),
      mk("a", "polish", true, "2026-01-02"), // rerun replaces the earlier fail
      mk("b", "polish", true, "2026-01-02"),
      mk("c", "implement", false, "2026-01-02"),
      mk("d", "implement", true, "2026-01-02"),
    ]);
    strictEqual(s.polish?.pass, 2);
    strictEqual(s.polish?.total, 2);
    strictEqual(s.implement?.pass, 1);
    strictEqual(s.implement?.total, 2);
  });
});

describe("eval fixtures", () => {
  it("every shipped task validates (name/class/prompt/check.mjs/setup)", () => {
    const { tasks, errors } = listEvalTasks(path.resolve("tasks"));
    deepStrictEqual(errors, []);
    ok(tasks.length >= 12, `expected the full fixture set, found ${tasks.length}`);
    const classes = new Set(tasks.map((t) => t.class));
    ok(classes.has("polish") && classes.has("implement"), "both classes must be represented — the bars are per-class");
  });

  it("rejects a task whose task.json disagrees with its directory name", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-evalbad-"));
    try {
      fs.mkdirSync(path.join(root, "wrong-name"), { recursive: true });
      fs.writeFileSync(path.join(root, "wrong-name", "task.json"), JSON.stringify({ name: "other", class: "polish", prompt: "x" }));
      const { tasks, errors } = listEvalTasks(root);
      strictEqual(tasks.length, 0);
      strictEqual(errors.length, 1);
      ok(errors[0]?.error.includes("name"), errors[0]?.error);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runEval end-to-end (scripted model, no network)", () => {
  it("a scripted fix passes the checker, records eval + merges the outcome", async () => {
    const host = tempCwd();
    try {
      const solved = '{\n  "port": 8080,\n  "host": "localhost",\n  "debug": false\n}\n';
      const { port } = makeFakePort([
        toolTurn("write", JSON.stringify({ path: "config.json", content: solved })),
        textTurn("done — port moved to 8080"),
      ]);
      const logs: string[] = [];
      const { results, setupErrors } = await runEval({
        tasksRoot: path.resolve("tasks"),
        cwd: host,
        only: "config-port",
        port,
        provider: "fake",
        model: "scripted",
        maxSteps: 10,
        taskTimeoutMs: 30_000,
        keepTemp: false,
        onLog: (l) => logs.push(l),
      });
      deepStrictEqual(setupErrors, []);
      strictEqual(results.length, 1);
      const r = results[0];
      ok(r !== undefined);
      strictEqual(r.pass, true, `expected pass, reason: ${r.reason ?? "(none)"}`);
      strictEqual(r.task, "config-port");
      strictEqual(r.class, "polish");
      // eval.jsonl landed on the host…
      const rows = readEvalRecords(host);
      strictEqual(rows.length, 1);
      strictEqual(rows[0]?.pass, true);
      // …and the run's outcome was merged before the temp dir vanished.
      const outcomes = readOutcomeRecords(host);
      strictEqual(outcomes.length, 1);
      strictEqual(outcomes[0]?.runId, r.runId);
      ok(logs.some((l) => l.includes("PASS")));
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });

  it("a model that never fixes anything fails the checker with an honest reason", async () => {
    const host = tempCwd();
    try {
      const { port } = makeFakePort([textTurn("I read the file but chose not to change anything.")]);
      const { results } = await runEval({
        tasksRoot: path.resolve("tasks"),
        cwd: host,
        only: "config-port",
        port,
        provider: "fake",
        model: "scripted",
        maxSteps: 10,
        taskTimeoutMs: 30_000,
        keepTemp: false,
        onLog: () => {},
      });
      strictEqual(results.length, 1);
      const r = results[0];
      ok(r !== undefined);
      strictEqual(r.pass, false);
      ok(r.reason !== undefined && r.reason.includes("checker exit"), r.reason ?? "(no reason)");
      ok(readEvalRecords(host)[0]?.pass === false);
    } finally {
      fs.rmSync(host, { recursive: true, force: true });
    }
  });
});
