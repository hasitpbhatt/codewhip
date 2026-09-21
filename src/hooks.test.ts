import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_ENV } from "./config-dir.js";
import { loadHooks, runHooksFor, type HookDef, type HookPayload, type HookDeps, type SpawnResult } from "./hooks.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function payload(over: Partial<HookPayload> = {}): HookPayload {
  return { event: "PreToolUse", tool: "bash", seq: 1, runId: "r1", cwd: "/c", args: { command: "ls" }, ...over };
}

function fakeSpawner(results: SpawnResult[], seen: { command: string; stdin: string; env: Record<string, string> }[]): HookDeps {
  let i = 0;
  return {
    spawnHook: (command, stdin, env) => {
      seen.push({ command, stdin, env });
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      return Promise.resolve(r);
    },
  };
}

const PASS: SpawnResult = { code: 0, stdout: "", stderr: "", timedOut: false };
const DENY2: SpawnResult = { code: 2, stdout: "", stderr: "not on principle", timedOut: false };

describe("hooks", () => {
  it("loadHooks: missing files are no-hooks, not errors", () => {
    const r = loadHooks(tmpDir("codewhip-hooks-none-"));
    strictEqual(r.defs.length, 0);
    strictEqual(r.errors.length, 0);
  });

  it("loadHooks merges user + project files and reports invalid entries", () => {
    const userDir = tmpDir("codewhip-hooks-user-");
    const cwd = tmpDir("codewhip-hooks-proj-");
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    fs.writeFileSync(
      path.join(userDir, "hooks.json"),
      JSON.stringify({ hooks: [{ event: "PreToolUse", match: "bash", command: "echo a" }] }),
    );
    fs.writeFileSync(
      path.join(cwd, ".codewhip", "hooks.json"),
      JSON.stringify([
        { event: "PostToolUse", match: "*", command: "echo b" },
        { event: "Nope", match: "*", command: "x" },
        { event: "Stop", match: "notatool", command: "x" },
        { event: "Stop", match: "*", command: "" },
      ]),
    );
    const prev = process.env[CONFIG_DIR_ENV];
    process.env[CONFIG_DIR_ENV] = userDir;
    try {
      const r = loadHooks(cwd);
      strictEqual(r.defs.length, 2);
      strictEqual(r.defs[0]?.command, "echo a");
      strictEqual(r.defs[1]?.event, "PostToolUse");
      strictEqual(r.errors.length, 3);
    } finally {
      if (prev === undefined) delete process.env[CONFIG_DIR_ENV];
      else process.env[CONFIG_DIR_ENV] = prev;
    }
  });

  it("loadHooks: invalid JSON surfaces an error; the 17th def hits the cap", () => {
    const userDir = tmpDir("codewhip-hooks-user2-");
    const cwd = tmpDir("codewhip-hooks-proj2-");
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "hooks.json"), "{not json");
    const many = Array.from({ length: 17 }, (_, i) => ({ event: "Stop", match: "*", command: `c${i}` }));
    fs.writeFileSync(path.join(cwd, ".codewhip", "hooks.json"), JSON.stringify(many));
    const prev = process.env[CONFIG_DIR_ENV];
    process.env[CONFIG_DIR_ENV] = userDir;
    try {
      const r = loadHooks(cwd);
      ok(r.errors.some((e) => e.includes("invalid JSON")), r.errors.join(" | "));
      strictEqual(r.defs.length, 16);
      ok(r.errors.some((e) => e.includes("cap")), r.errors.join(" | "));
    } finally {
      if (prev === undefined) delete process.env[CONFIG_DIR_ENV];
      else process.env[CONFIG_DIR_ENV] = prev;
    }
  });

  it("runHooksFor: exit 2 denies with reason; exit 0 JSON deny denies; plain 0 passes", async () => {
    const defs: HookDef[] = [{ event: "PreToolUse", match: "*", command: "x" }];
    const seen: { command: string; stdin: string; env: Record<string, string> }[] = [];
    const deny = await runHooksFor(defs, "PreToolUse", "bash", payload(), fakeSpawner([DENY2], seen));
    strictEqual(deny.status, "deny");
    strictEqual(deny.reason, "not on principle");
    strictEqual(deny.fired, 1);
    const jsonDeny = await runHooksFor(defs, "PreToolUse", "bash", payload(),
      fakeSpawner([{ code: 0, stdout: '{"decision":"deny","reason":"policy says no"}', stderr: "", timedOut: false }], seen));
    strictEqual(jsonDeny.status, "deny");
    strictEqual(jsonDeny.reason, "policy says no");
    const pass = await runHooksFor(defs, "PreToolUse", "bash", payload(), fakeSpawner([PASS], seen));
    strictEqual(pass.status, "pass");
    strictEqual(pass.fired, 1);
  });

  it("runHooksFor: exit 1, timeout and crash WARN and proceed; a later deny still short-circuits", async () => {
    const defs: HookDef[] = [
      { event: "PreToolUse", match: "*", command: "first" },
      { event: "PreToolUse", match: "*", command: "second" },
    ];
    const seen: { command: string; stdin: string; env: Record<string, string> }[] = [];
    const warn = await runHooksFor(defs, "PreToolUse", "bash", payload(),
      fakeSpawner([{ code: 1, stdout: "", stderr: "boom", timedOut: false }, { code: -1, stdout: "", stderr: "spawn failed", timedOut: false }], seen));
    strictEqual(warn.status, "warn");
    strictEqual(warn.fired, 2);
    const timed = await runHooksFor(defs, "PreToolUse", "bash", payload(),
      fakeSpawner([{ code: -1, stdout: "", stderr: "", timedOut: true }], seen));
    strictEqual(timed.status, "warn");
    ok(timed.reason.includes("timed out"), timed.reason);
    const denySecond = await runHooksFor(defs, "PreToolUse", "bash", payload(), fakeSpawner([PASS, DENY2], seen));
    strictEqual(denySecond.status, "deny");
    strictEqual(denySecond.fired, 2);
  });

  it("runHooksFor: match filters by tool for tool events; Stop runs every Stop hook", async () => {
    const defs: HookDef[] = [
      { event: "PreToolUse", match: "edit", command: "e" },
      { event: "PreToolUse", match: "bash", command: "b" },
      { event: "PreToolUse", match: "*", command: "s" },
      { event: "Stop", match: "bash", command: "z" },
    ];
    const seen: { command: string; stdin: string; env: Record<string, string> }[] = [];
    const r = await runHooksFor(defs, "PreToolUse", "bash", payload(), fakeSpawner([PASS], seen));
    strictEqual(r.fired, 2);
    strictEqual(seen.at(-2)?.command, "b");
    strictEqual(seen.at(-1)?.command, "s");
    const stop = await runHooksFor(defs, "Stop", "", payload({ event: "Stop", tool: "" }), fakeSpawner([PASS], seen));
    strictEqual(stop.fired, 1);
    strictEqual(stop.status, "pass");
  });

  it("runHooksFor: payload + env ride stdin; deny reasons are redacted", async () => {
    const defs: HookDef[] = [{ event: "PreToolUse", match: "bash", command: "c" }];
    const seen: { command: string; stdin: string; env: Record<string, string> }[] = [];
    await runHooksFor(defs, "PreToolUse", "bash", payload(), fakeSpawner([PASS], seen));
    const doc = JSON.parse(seen[0]?.stdin ?? "{}") as HookPayload;
    strictEqual(doc.event, "PreToolUse");
    strictEqual(doc.tool, "bash");
    strictEqual(doc.runId, "r1");
    strictEqual(doc.cwd, "/c");
    strictEqual(seen[0]?.env["CODEWHIP_EVENT"], "PreToolUse");
    strictEqual(seen[0]?.env["CODEWHIP_TOOL"], "bash");
    strictEqual(seen[0]?.env["CODEWHIP_RUN_ID"], "r1");
    const leak = await runHooksFor(defs, "PreToolUse", "bash", payload(),
      fakeSpawner([{ code: 2, stdout: "", stderr: "because sk-abcdef123456", timedOut: false }], seen));
    strictEqual(leak.status, "deny");
    ok(!leak.reason.includes("sk-abcdef123456"), leak.reason);
    ok(leak.reason.includes("[redacted]"), leak.reason);
  });

  it("real-spawn smoke: platform shell exit 2 denies, exit 0 passes", async () => {
    const denyDefs: HookDef[] = [{ event: "PreToolUse", match: "bash", command: "exit 2" }];
    const r = await runHooksFor(denyDefs, "PreToolUse", "bash", payload());
    strictEqual(r.status, "deny");
    strictEqual(r.fired, 1);
    const passDefs: HookDef[] = [{ event: "PreToolUse", match: "bash", command: "exit 0" }];
    const p = await runHooksFor(passDefs, "PreToolUse", "bash", payload());
    strictEqual(p.status, "pass");
  });
});
