import { describe, it } from "node:test";
import { rejects, strictEqual, ok, throws } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { query, tool, SdkError, type Query, type SdkMessage } from "./sdk.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { saveAllowedEntries } from "./model-allowlist.js";
import { CONFIG_DIR_ENV } from "./config-dir.js";

/**
 * The public programmatic entry (parity doc wave 2: Agent SDK). These tests
 * pin what is *this file's* job — the gates and the envelope — not the loop's
 * (see `host-tools.test.ts` for what a host tool does inside a run).
 *
 * Every functional test passes `port`, which replaces the provider/key lookup
 * only: policy, budgets, audit and the ask ladder still run.
 */

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function collect(q: Query): Promise<SdkMessage[]> {
  const out: SdkMessage[] = [];
  for await (const m of q) out.push(m);
  return out;
}

function doc(m: SdkMessage): Record<string, unknown> {
  return m as Record<string, unknown>;
}

function results(msgs: SdkMessage[]): Array<Record<string, unknown>> {
  return msgs.filter((m) => m.type === "result").map(doc);
}

/** A refusal this module owns: the class and the cause both have to match. */
function sdkFails(why: RegExp): (err: unknown) => boolean {
  return (err) => err instanceof SdkError && why.test(err.message);
}

const heldTool = (onExec: () => void) => tool({
  name: "lookup_bug",
  description: "Look up an issue by id",
  inputSchema: { type: "object", properties: { id: { type: "integer" } } },
  handler: (args) => {
    onExec();
    return `NPE at line ${String(args.id)}`;
  },
});

describe("tool()", () => {
  it("accepts a well-formed definition and rejects one that cannot be graded", () => {
    strictEqual(tool({
      name: "lookup_bug",
      description: "d",
      inputSchema: { type: "object" },
      handler: () => "x",
    }).name, "lookup_bug");
    const base = { description: "d", inputSchema: { type: "object" }, handler: () => "x" };
    const bad: Array<{ def: unknown; why: RegExp }> = [
      { def: { ...base, name: "read" }, why: /built-in tool/ },
      { def: { ...base, name: "Read" }, why: /is not a tool name/ },
      { def: { name: "t", description: "d", inputSchema: { type: "array" }, handler: () => "x" }, why: /type: "object"/ },
      { def: { ...base, name: "lookup_bug", handler: undefined }, why: /has no handler/ },
      { def: { ...base, name: "lookup_bug", timeoutMs: 50 }, why: /timeout must be an integer/ },
    ];
    for (const { def, why } of bad) {
      throws(() => tool(def as never), sdkFails(why));
    }
  });
});

describe("query()", () => {
  it("yields init, then the run's events, then exactly one result document", async () => {
    const cwd = tmpDir("codewhip-sdk-run-");
    const { port } = makeFakePort([textTurn("all done")]);
    const msgs = await collect(query({
      prompt: "say something",
      options: { port, provider: "nvidia", model: "m", cwd },
    }));
    strictEqual(msgs[0]?.type, "system");
    strictEqual(doc(msgs[0]!).subtype, "init");
    strictEqual(doc(msgs[0]!).provider, "nvidia");
    strictEqual(doc(msgs[0]!).max_turns, 25);
    strictEqual(results(msgs).length, 1);
    const r = results(msgs)[0]!;
    strictEqual(r.subtype, "success");
    strictEqual(r.result, "all done");
    strictEqual(typeof r.run_id, "string");
    ok(String(r.receipt).startsWith("receipt: "), "the receipt line is on the machine document too");
    ok(String(r.cost).includes("$") || String(r.cost).includes("untracked"), "cost is stated, never invented");
  });

  it("runs a host tool the model called, through the handler the caller wrote", async () => {
    const cwd = tmpDir("codewhip-sdk-tool-");
    let seen: unknown;
    const t = tool({
      name: "lookup_bug",
      description: "d",
      inputSchema: { type: "object", properties: { id: { type: "integer" } } },
      handler: (args) => {
        seen = args;
        return `NPE at line ${String(args.id)}`;
      },
    });
    const { port, record } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const msgs = await collect(query({
      prompt: "triage",
      options: { port, provider: "nvidia", model: "m", cwd, tools: [t], yolo: true },
    }));
    strictEqual(record[0]?.toolCount, 13, "the twelve keyboard-free builtins plus the host tool");
    strictEqual(JSON.stringify(doc(msgs[0]!).custom_tools), '["lookup_bug"]');
    strictEqual(JSON.stringify(seen), '{"id":7}');
    strictEqual(results(msgs)[0]!.result, "fixed");
  });

  it("asks canUseTool with the graded subject, and executes on an allow", async () => {
    const cwd = tmpDir("codewhip-sdk-ask-");
    const asks: Array<{ tool: string; ruleId: string; subject: string }> = [];
    const execs: unknown[] = [];
    const t = tool({
      name: "lookup_bug",
      description: "d",
      inputSchema: { type: "object" },
      handler: (args) => {
        execs.push(args);
        return "found it";
      },
    });
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("fixed")]);
    const msgs = await collect(query({
      prompt: "triage",
      options: {
        port,
        provider: "nvidia",
        model: "m",
        cwd,
        tools: [t],
        canUseTool: (name, input, ctx) => {
          asks.push({ tool: name, ruleId: ctx.ruleId, subject: ctx.subject });
          // A smuggled `updatedInput` is not in the contract and is ignored:
          // what policy graded is what executes.
          return { behavior: "allow", updatedInput: { id: 999 } } as never;
        },
      },
    }));
    strictEqual(asks.length, 1);
    strictEqual(asks[0]?.tool, "lookup_bug");
    strictEqual(asks[0]?.ruleId, "default:host-tool:ask");
    strictEqual(asks[0]?.subject, '{"id":7}');
    strictEqual(JSON.stringify(execs[0]), '{"id":7}', "no rewritten arguments reached the handler");
    const trace = results(msgs)[0]!.trace as Array<{ tool: string; policy: string; actor: string }>;
    strictEqual(trace.find((x) => x.tool === "lookup_bug")?.actor, "human");
  });

  it("a deny from the host refuses the call, and the run keeps going", async () => {
    const cwd = tmpDir("codewhip-sdk-deny-");
    let execs = 0;
    const t = tool({
      name: "lookup_bug",
      description: "d",
      inputSchema: { type: "object" },
      handler: () => {
        execs += 1;
        return "should not run";
      },
    });
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("ok, I will not")]);
    const msgs = await collect(query({
      prompt: "triage",
      options: {
        port,
        provider: "nvidia",
        model: "m",
        cwd,
        tools: [t],
        canUseTool: () => ({ behavior: "deny", message: "not in this repo" }),
      },
    }));
    strictEqual(execs, 0);
    strictEqual(results(msgs)[0]!.result, "ok, I will not");
    const trace = results(msgs)[0]!.trace as Array<{ tool: string; policy: string }>;
    ok(String(trace.find((x) => x.tool === "lookup_bug")?.policy).startsWith("deny:"), "refused, with the rule pointer");
  });

  it("canUseTool is never consulted for something policy already refused", async () => {
    const cwd = tmpDir("codewhip-sdk-plan-");
    let asks = 0;
    const { port } = makeFakePort([toolTurn("edit", '{"path":"a.ts","oldText":"x","newText":"y"}'), textTurn("plan only")]);
    const msgs = await collect(query({
      prompt: "change it",
      options: {
        port,
        provider: "nvidia",
        model: "m",
        cwd,
        plan: true,
        canUseTool: () => {
          asks += 1;
          return { behavior: "allow" };
        },
      },
    }));
    strictEqual(asks, 0, "a decider mounted on the ask rung cannot reach a deny");
    const trace = results(msgs)[0]!.trace as Array<{ tool: string; policy: string }>;
    strictEqual(trace.find((x) => x.tool === "edit")?.policy, "deny:plan:read-only");
  });

  it("with no canUseTool, an ask is held and denied — never self-approved", async () => {
    const cwd = tmpDir("codewhip-sdk-held-");
    let execs = 0;
    const t = heldTool(() => {
      execs += 1;
    });
    const { port } = makeFakePort([toolTurn("lookup_bug", '{"id":7}'), textTurn("understood")]);
    const msgs = await collect(query({
      prompt: "triage",
      options: { port, provider: "nvidia", model: "m", cwd, tools: [t] },
    }));
    strictEqual(execs, 0);
    strictEqual(results(msgs)[0]!.result, "understood");
  });

  it("an async prompt stream is several turns of one session, with one result per turn", async () => {
    const cwd = tmpDir("codewhip-sdk-multi-");
    const { port, record, messagesSeen } = makeFakePort([
      textTurn("first answer"),
      textTurn("second answer"),
    ]);
    async function* prompts(): AsyncGenerator<string> {
      yield "one";
      yield "two";
    }
    const msgs = await collect(query({
      prompt: prompts(),
      options: { port, provider: "nvidia", model: "m", cwd },
    }));
    strictEqual(msgs.filter((m) => m.type === "system").length, 1, "one init for the whole session");
    const rs = results(msgs);
    strictEqual(rs.length, 2);
    strictEqual(rs[0]!.result, "first answer");
    strictEqual(rs[1]!.result, "second answer");
    ok(rs[0]!.run_id !== rs[1]!.run_id, "each turn is a run with its own id (and its own undo line)");
    strictEqual(record.length, 2);
    ok(
      messagesSeen[1]!.some((m) => m.role === "assistant" && m.content === "first answer"),
      "turn two carries turn one's transcript"
    );
  });

  it("the enabled-model consent gate fires before a key, a port or a token", async () => {
    const cfg = tmpDir("codewhip-sdk-cfg-");
    const cwd = tmpDir("codewhip-sdk-cwd-");
    const prevCfg = process.env[CONFIG_DIR_ENV];
    const prevKey = process.env.GROQ_API_KEY;
    process.env[CONFIG_DIR_ENV] = cfg;
    delete process.env.GROQ_API_KEY;
    try {
      await rejects(
        collect(query({
          prompt: "hi",
          options: { provider: "groq", model: "made-up-model", cwd, dir: cfg },
        })),
        sdkFails(/is not enabled/)
      );
      // Enabling it moves the refusal along the same ladder — to the credential
      // check — which is what proves the gate was the first thing blocking.
      saveAllowedEntries(["groq:made-up-model"], cfg);
      await rejects(
        collect(query({
          prompt: "hi",
          options: { provider: "groq", model: "made-up-model", cwd, dir: cfg },
        })),
        sdkFails(/no key for groq/)
      );
    } finally {
      if (prevCfg === undefined) delete process.env[CONFIG_DIR_ENV];
      else process.env[CONFIG_DIR_ENV] = prevCfg;
      if (prevKey !== undefined) process.env.GROQ_API_KEY = prevKey;
    }
  });

  it("refuses a dollar ceiling on a route it cannot meter, and bounds steps otherwise", async () => {
    const cwd = tmpDir("codewhip-sdk-budget-");
    const { port } = makeFakePort([toolTurn("read", '{"path":"."}')]);
    await rejects(
      collect(query({
        prompt: "hi",
        options: { port, provider: "nvidia", model: "unpriced-model", cwd, maxBudgetUsd: 1 },
      })),
      sdkFails(/unpriced/)
    );
    const msgs = await collect(query({
      prompt: "hi",
      options: { port, provider: "nvidia", model: "m", cwd, maxTurns: 2, yolo: true },
    }));
    strictEqual(results(msgs)[0]!.subtype, "error_max_steps");
    strictEqual(results(msgs).length, 1, "a stream ends at the turn that failed, like the CLI");
  });

  it("validates its own options instead of half-running", async () => {
    const cwd = tmpDir("codewhip-sdk-badopts-");
    const { port } = makeFakePort([textTurn("x")]);
    await rejects(
      collect(query({ prompt: "hi", options: { port, provider: "nvidia", model: "m", cwd, maxTurns: 500 } })),
      sdkFails(/maxTurns/)
    );
    await rejects(
      collect(query({ prompt: "hi", options: { port, model: "m", cwd } })),
      sdkFails(/must name its provider/)
    );
    await rejects(
      collect(query({
        prompt: "hi",
        options: { port, provider: "nvidia", model: "m", cwd, allowedTools: "not-a-tool(x)" },
      })),
      sdkFails(/allowedTools/)
    );
  });
});
