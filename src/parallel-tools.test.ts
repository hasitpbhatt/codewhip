import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop } from "./loop.js";
import { TOOLS } from "./tools/registry.js";
import { makeFakePort, textTurn, toolBatchTurn } from "./testkit/fakePort.js";
import { verifyChain } from "./audit.js";
import { readOutcomeRecords } from "./outcomes.js";
import { MAX_PARALLEL_TOOL_CALLS, runBoundedParallel } from "./parallel-tools.js";
import type { ToolContext, ToolResult } from "./tools/types.js";
import type { ToolExec } from "./tools/registry.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function batchReadCalls(count: number): Array<{ id: string; name: string; argsJson: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `call-${i}`,
    name: "read",
    argsJson: JSON.stringify({ path: `f${i}.txt` }),
  }));
}

describe("parallel tools", () => {
  it("runBoundedParallel keeps input order when work finishes out of order", async () => {
    const out = await runBoundedParallel([40, 5, 20], 3, async (ms, i) => {
      await sleep(ms);
      return `${i}:${ms}`;
    });
    ok(JSON.stringify(out) === JSON.stringify(["0:40", "1:5", "2:20"]), JSON.stringify(out));
  });

  it("overlaps a read batch, caps it at four, and commits audit + transcript in call order", async () => {
    const runCwd = tmp("codewhip-parallel-read-");
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(runCwd, `f${i}.txt`), `body ${i}\n`, "utf8");
    const real = TOOLS.read.exec;
    let active = 0;
    let peak = 0;
    TOOLS.read.exec = async (ctx, args, signal): Promise<ToolResult> => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep((args as { path: string }).path.endsWith("0.txt") ? 40 : 5);
        return await real(ctx, args, signal);
      } finally {
        active -= 1;
      }
    };
    try {
      const { port, messagesSeen } = makeFakePort([toolBatchTurn(batchReadCalls(6)), textTurn("done")]);
      const r = await agentLoop({
        prompt: "read them all", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
        stdinIsTTY: true, port, askUser: async () => "no",
      });
      strictEqual(r.text, "done");
      strictEqual(peak, MAX_PARALLEL_TOOL_CALLS);
      const sent = messagesSeen[1]?.filter((m) => m.role === "tool") ?? [];
      ok(JSON.stringify(sent.map((m) => m.toolCallId)) === JSON.stringify(batchReadCalls(6).map((c) => c.id)), JSON.stringify(sent));
      ok(JSON.stringify(r.trace.map((t) => t.seq)) === JSON.stringify([1, 2, 3, 4, 5, 6]), JSON.stringify(r.trace));
      const rec = readOutcomeRecords(runCwd).at(-1);
      ok(JSON.stringify(rec?.tool_calls.map((c) => c.seq)) === JSON.stringify([1, 2, 3, 4, 5, 6]), JSON.stringify(rec?.tool_calls));
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      TOOLS.read.exec = real;
    }
  });

  it("overlaps pre-approved webfetches and records the yolo grant on each", async () => {
    const runCwd = tmp("codewhip-parallel-fetch-");
    const real = TOOLS.webfetch.exec;
    let active = 0;
    let peak = 0;
    TOOLS.webfetch.exec = async (_ctx, args, _signal): Promise<ToolResult> => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep(20);
        return { ok: true, output: `fetched ${(args as { url: string }).url}` };
      } finally {
        active -= 1;
      }
    };
    try {
      const calls = [
        { id: "w1", name: "webfetch", argsJson: JSON.stringify({ url: "https://one.example/a" }) },
        { id: "w2", name: "webfetch", argsJson: JSON.stringify({ url: "https://two.example/b" }) },
      ];
      const { port } = makeFakePort([toolBatchTurn(calls), textTurn("done")]);
      const r = await agentLoop({
        prompt: "fetch both", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
        stdinIsTTY: true, port, askUser: async () => "no",
      });
      strictEqual(peak, 2);
      ok(r.trace.every((t) => t.policy === "allow:default:webfetch:ask+yolo"), JSON.stringify(r.trace));
      ok(r.trace.every((t) => t.actor === "yolo"), JSON.stringify(r.trace));
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      TOOLS.webfetch.exec = real;
    }
  });

  it("falls back to serial when one call is not provably read-only", async () => {
    const runCwd = tmp("codewhip-parallel-mixed-");
    fs.writeFileSync(path.join(runCwd, "f.txt"), "body\n", "utf8");
    const readReal = TOOLS.read.exec;
    const searchReal = TOOLS.search.exec;
    let active = 0;
    let peak = 0;
    const tracked = async (realExec: ToolExec, ctx: ToolContext, args: unknown, signal?: AbortSignal): Promise<ToolResult> => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep(10);
        return await realExec(ctx, args, signal);
      } finally {
        active -= 1;
      }
    };
    TOOLS.read.exec = (ctx, args, signal) => tracked(readReal, ctx, args, signal);
    TOOLS.search.exec = (ctx, args, signal) => tracked(searchReal, ctx, args, signal);
    try {
      const { port } = makeFakePort([
        toolBatchTurn([
          { id: "r1", name: "read", argsJson: JSON.stringify({ path: "f.txt" }) },
          { id: "s1", name: "search", argsJson: JSON.stringify({ query: "body" }) },
        ]),
        textTurn("done"),
      ]);
      await agentLoop({
        prompt: "read and search", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
        stdinIsTTY: true, port, askUser: async () => "no",
      });
      strictEqual(peak, 1);
    } finally {
      TOOLS.read.exec = readReal;
      TOOLS.search.exec = searchReal;
    }
  });

  it("duplicate call ids fall back rather than guessing which result belongs where", async () => {
    const runCwd = tmp("codewhip-parallel-dup-");
    fs.writeFileSync(path.join(runCwd, "f.txt"), "body\n", "utf8");
    const real = TOOLS.read.exec;
    let execs = 0;
    TOOLS.read.exec = (ctx, args, signal) => {
      execs += 1;
      return real(ctx, args, signal);
    };
    try {
      const { port } = makeFakePort([
        toolBatchTurn([
          { id: "same", name: "read", argsJson: JSON.stringify({ path: "f.txt", offset: 1 }) },
          { id: "same", name: "read", argsJson: JSON.stringify({ path: "f.txt", offset: 2 }) },
        ]),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "read it twice", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
        stdinIsTTY: true, port, askUser: async () => "no",
      });
      strictEqual(execs, 2);
      strictEqual(r.trace.length, 2);
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      TOOLS.read.exec = real;
    }
  });

  it("a hook anywhere in the run keeps the whole batch serial", async () => {
    const runCwd = tmp("codewhip-parallel-hook-");
    fs.writeFileSync(path.join(runCwd, "f.txt"), "body\n", "utf8");
    const real = TOOLS.read.exec;
    let active = 0;
    let peak = 0;
    TOOLS.read.exec = async (ctx, args, signal) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await sleep(10);
        return await real(ctx, args, signal);
      } finally {
        active -= 1;
      }
    };
    try {
      const { port } = makeFakePort([toolBatchTurn(batchReadCalls(2)), textTurn("done")]);
      await agentLoop({
        prompt: "read them", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5, yolo: true,
        stdinIsTTY: true, port, askUser: async () => "no",
        hooks: { defs: [{ event: "PreToolUse", match: "read", command: "exit 0" }], errors: [] },
        hookDeps: { spawnHook: async () => ({ code: 0, stdout: "", stderr: "", timedOut: false }) },
      });
      strictEqual(peak, 1);
    } finally {
      TOOLS.read.exec = real;
    }
  });
});
