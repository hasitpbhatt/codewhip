import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop } from "./loop.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { parseQuestionAnswer, questionPrompt } from "./index.js";
import { runAskUser } from "./tools/ask-user.js";
import { TOOLS } from "./tools/registry.js";
import { readOutcomeRecords } from "./outcomes.js";
import type { AskUserQuestion, ToolContext, UserQuestion } from "./tools/types.js";

/**
 * ask_user — the model putting one multiple-choice question to the human who
 * started the run. The invariants under test are that it grants nothing (an
 * answer is a tool result, not a permission), that it exists only where a human
 * is reachable (no channel ⇒ refusal that keeps the question visible), and that
 * a subagent can never hold the keyboard.
 */

function ctxFor(over: Partial<ToolContext> = {}): ToolContext {
  return { cwd: fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-ask-")), ...over };
}

function asker(answer: string[] | null, seen: UserQuestion[]): AskUserQuestion {
  return async (q) => {
    seen.push(q);
    return answer;
  };
}

const Q = { question: "Which parser?", options: ["recursive descent", "peg"], multiSelect: false };

describe("parseQuestionAnswer (the terminal's reading of one reply)", () => {
  it("reads a number as that option, and only the first one when single-select", () => {
    const q: UserQuestion = { question: "x", options: ["one", "two", "three"], multiSelect: false };
    strictEqual(parseQuestionAnswer(q, "2")?.[0], "two");
    deepStrictEqual(parseQuestionAnswer(q, "1,3"), ["one"], "single-select ignores the extra pick");
    deepStrictEqual(parseQuestionAnswer(q, " 3 "), ["three"]);
  });

  it("keeps every pick when multiSelect, deduped in the order they were named", () => {
    const q: UserQuestion = { question: "x", options: ["one", "two", "three"], multiSelect: true };
    deepStrictEqual(parseQuestionAnswer(q, "3, 1, 3"), ["three", "one"]);
  });

  it("treats anything that is not an in-range number as the human's own words", () => {
    const q: UserQuestion = { question: "x", options: ["one", "two"], multiSelect: false };
    deepStrictEqual(parseQuestionAnswer(q, "write it in Rust"), ["write it in Rust"]);
    deepStrictEqual(parseQuestionAnswer(q, "ONE"), ["one"], "an option typed verbatim canonicalises");
    deepStrictEqual(parseQuestionAnswer(q, "7"), ["7"], "an out-of-range number is text, not a crash");
    strictEqual(parseQuestionAnswer(q, "   "), null, "no answer at all");
  });

  it("renders the question as a numbered list, with a hint that matches multiSelect", () => {
    strictEqual(
      questionPrompt({ question: "Ship both?", options: ["yes", "no"], multiSelect: true }),
      "\nShip both?\n  1. yes\n  2. no\n(answer with several numbers with commas, or type your own words) > "
    );
    ok(!questionPrompt(Q).includes("several numbers"), "single-select must not invite a list");
  });
});

describe("ask_user tool", () => {
  it("hands the asker a trimmed question and returns the answer as a tool result", async () => {
    const seen: UserQuestion[] = [];
    const ctx = ctxFor({ askUserQuestion: asker(["peg"], seen) });
    const r = await runAskUser(ctx, { question: "  Which parser?  ", options: ["recursive descent", " peg "], multiSelect: "true" });
    strictEqual(r.ok, true);
    strictEqual(r.output, "the human answered: peg");
    strictEqual(seen.length, 1);
    strictEqual(seen[0]?.question, "Which parser?");
    deepStrictEqual(seen[0]?.options, ["recursive descent", "peg"]);
    strictEqual(seen[0]?.multiSelect, false, "multiSelect is a boolean or false — a string is not true");
  });

  it("refuses a headless run without losing the question it could not ask", async () => {
    const r = await runAskUser(ctxFor(), Q);
    strictEqual(r.ok, false);
    ok(r.output.includes("no human at this keyboard"), r.output);
    ok(r.output.includes("Which parser?"), r.output);
    ok(r.output.includes("peg"), r.output);
  });

  it("reports an interrupted wait as no answer, not as an empty one", async () => {
    const ctx = ctxFor({ askUserQuestion: asker(null, []) });
    const r = await runAskUser(ctx, Q);
    strictEqual(r.ok, false);
    ok(r.output.includes("no answer (interrupted)"), r.output);
  });

  it("refuses a child run even when a channel is present", async () => {
    const ctx = ctxFor({ depth: 1, askUserQuestion: asker(["peg"], []) });
    const r = await runAskUser(ctx, Q);
    strictEqual(r.ok, false);
    ok(r.output.includes("subagents cannot prompt the human"), r.output);
  });

  it("refuses a question already cancelled before it was asked", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runAskUser(ctxFor({ askUserQuestion: asker(["peg"], []) }), Q, ctrl.signal);
    strictEqual(r.ok, false);
    ok(r.output.includes("cancelled before the question was asked"), r.output);
  });

  it("rejects nonsense questions at the boundary: empty, too long, too few, too many, duplicate, blank", async () => {
    for (const [args, want] of [
      [{ question: "  ", options: ["a", "b"] }, "question is empty"],
      [{ question: "q".repeat(500), options: ["a", "b"] }, "question too long"],
      [{ question: "q", options: ["only"] }, "options must be 2-6"],
      [{ question: "q", options: ["1", "2", "3", "4", "5", "6", "7"] }, "options must be 2-6"],
      [{ question: "q", options: ["same", "SAME"] }, "options must be distinct"],
      [{ question: "q", options: ["ok", "   "] }, "every option must be non-empty"],
      [{ question: "q", options: ["ok", "x".repeat(90)] }, "option too long"],
    ] as const) {
      const r = await runAskUser(ctxFor({ askUserQuestion: asker(["a"], []) }), args);
      strictEqual(r.ok, false, JSON.stringify(args));
      ok(r.output.includes(want), `${want} — got ${r.output}`);
    }
  });

  it("is the thirteenth builtin, so it resolves by name like any other", () => {
    strictEqual(Object.keys(TOOLS).length, 13);
    strictEqual(TOOLS.ask_user.spec.name, "ask_user");
    ok(TOOLS.ask_user.timeoutMs > 60_000, "a human is the slowest thing in the harness");
  });
});

describe("ask_user in the loop", () => {
  function runCwd(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-ask-run-"));
  }
  const stubAsk = (): Promise<"yes"> => Promise.resolve("yes");

  it("advertises the tool only with a keyboard, answers through the policy allow rung", async () => {
    const dir = runCwd();
    const seen: UserQuestion[] = [];
    const { port, record } = makeFakePort([
      toolTurn("ask_user", JSON.stringify({ question: "Ship it?", options: ["yes", "no"], multiSelect: true })),
      textTurn("shipping"),
    ]);
    const r = await agentLoop({
      prompt: "ask first", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, askUserQuestion: asker(["yes", "no"], seen),
      remembered: [],
    });
    strictEqual(record[0]?.toolCount, 13, "the question tool is advertised where a human is reachable");
    strictEqual(r.trace.find((t) => t.tool === "ask_user")?.policy, "allow:default:ask_user:allow");
    ok(r.messages.some((m) => m.role === "tool" && m.content === "the human answered: yes; no"), JSON.stringify(r.messages));
    strictEqual(r.error, undefined);
    strictEqual(seen[0]?.multiSelect, true);
  });

  it("is not advertised, and still refused, when no channel was injected", async () => {
    const dir = runCwd();
    const { port, record } = makeFakePort([
      toolTurn("ask_user", JSON.stringify({ question: "Ship it?", options: ["yes", "no"] })),
      textTurn("decided alone"),
    ]);
    const r = await agentLoop({
      prompt: "no keyboard here", model: "m", label: "nvidia", cwd: dir, maxSteps: 5, yolo: false,
      stdinIsTTY: false, port, remembered: [],
    });
    strictEqual(record[0]?.toolCount, 12, "headless advertises the twelve that can actually run");
    const toolMsg = r.messages.find((m) => m.role === "tool");
    ok(toolMsg?.content.includes("no human at this keyboard"), String(toolMsg?.content));
    strictEqual(r.error, undefined, "a refusal is a tool result, never a broken run");
  });

  it("refuses a subagent that fabricates the call — the parent run owns the keyboard", async () => {
    const dir = runCwd();
    const seen: UserQuestion[] = [];
    const { port, messagesSeen } = makeFakePort([
      toolTurn("delegate", JSON.stringify({ agent: "explore", task: "ask the human something" })),
      toolTurn("ask_user", JSON.stringify({ question: "Which file?", options: ["a", "b"] })),
      textTurn("I could not ask, so I read a.txt instead"),
      textTurn("reported back"),
    ]);
    const r = await agentLoop({
      prompt: "delegate", model: "m", label: "nvidia", cwd: dir, maxSteps: 6, yolo: false,
      stdinIsTTY: true, port, askUser: stubAsk, askUserQuestion: asker(["a"], seen),
      remembered: [],
    });
    // The child's transcript carries the refusal and its own runId carries the
    // audit entry — a child's trace never merges into the parent's, which is
    // what keeps the two runs separable on the chain.
    const toolOuts = messagesSeen.flat().filter((m) => m.role === "tool").map((m) => String(m.content));
    ok(
      toolOuts.some((s) => s.includes("the parent run owns the keyboard")),
      toolOuts.join(" | ")
    );
    const denied = readOutcomeRecords(dir)
      .flatMap((o) => o.tool_calls)
      .find((c) => c.tool === "ask_user");
    strictEqual(denied?.decision, "deny");
    strictEqual(denied?.ruleId, "loop:child-no-prompt");
    strictEqual(seen.length, 0, "a child's question never reaches the human");
    strictEqual(r.error, undefined);
  });
});
