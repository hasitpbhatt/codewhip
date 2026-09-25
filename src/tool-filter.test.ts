import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepStrictEqual, notEqual, ok, strictEqual } from "node:assert/strict";
import {
  delegationBlind,
  describeToolFilter,
  filtersToolEntirely,
  matchToolFilter,
  normBashSubject,
  parseToolFilter,
  parseToolFilterList,
} from "./tool-filter.js";
import type { ToolFilter } from "./tool-filter.js";
import { TOOL_NAMES, type ToolName } from "./tools/types.js";
import { TOOLS, toolSpecs } from "./tools/registry.js";
import { composeSystemPrompt, APPEND_MAX_CHARS } from "./system.js";
import { agentLoop } from "./loop.js";
import { parseRunArgs as parseRunArgsRef } from "./index.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { listRules } from "./remember-store.js";

/**
 * `--allowed-tools` / `--disallowed-tools` and the system-prompt surface.
 *
 * Two layers are pinned here: the filter grammar (pure, so the fail-closed
 * cases are cheap to enumerate) and what the loop does with a filter — the
 * grant/deny class is a *ladder position*, and that is exactly the part a
 * refactor can silently move.
 */

const f = (raw: string): ToolFilter | null => {
  const p = parseToolFilter(raw);
  return p.ok ? p.filter : null;
};

describe("tool filter grammar", () => {
  it("accepts a bare tool name and means the whole tool", () => {
    deepStrictEqual(f("read"), { tool: "read", shape: null });
    deepStrictEqual(f("  bash  "), { tool: "bash", shape: null });
  });
  it("normalizes a bash shape to lowercase, single-space form", () => {
    deepStrictEqual(f("bash(  Git   Status  * )"), { tool: "bash", shape: "git status *" });
    deepStrictEqual(f("bash(ls)"), { tool: "bash", shape: "ls" });
  });
  it("refuses an unknown tool, bare or shaped", () => {
    for (const raw of ["nope", "nope(x)", "BASH(ls)", "Todo"]) {
      const p = parseToolFilter(raw);
      strictEqual(p.ok, false, raw);
    }
  });
  it("refuses a shape on a tool that has no shape grammar", () => {
    const p = parseToolFilter("read(src/a.ts)");
    strictEqual(p.ok, false);
    if (!p.ok) ok(p.error.includes("takes no shape"), p.error);
  });
  it("refuses a bash shape carrying a shell separator", () => {
    for (const raw of ["bash(ls && rm -rf *)", "bash(cat a | wc *)", "bash(echo $HOME *)", "bash(ls; rm *)"]) {
      const p = parseToolFilter(raw);
      strictEqual(p.ok, false, raw);
      if (!p.ok) ok(p.error.includes("separator"), p.error);
    }
  });
  it("refuses more than one wildcard, or one that is not a trailing prefix", () => {
    strictEqual(parseToolFilter("bash(git * status)").ok, false);
    strictEqual(parseToolFilter("bash(* rm)").ok, false);
    strictEqual(parseToolFilter("bash(ls *)").ok, true);
  });
  it("refuses a path wildcard — name the path, or allow the whole tool", () => {
    strictEqual(parseToolFilter("edit(src/*.ts)").ok, false);
    strictEqual(parseToolFilter("write(src/a.ts)").ok, true);
  });
  it("requires an https origin, and stores the origin a full URL names", () => {
    strictEqual(parseToolFilter("webfetch(http://x.com)").ok, false);
    strictEqual(parseToolFilter("webfetch(x.com)").ok, false);
    deepStrictEqual(f("webfetch(https://x.com/docs/a)"), { tool: "webfetch", shape: "https://x.com" });
  });
  it("refuses an over-long shape and an unbalanced paren", () => {
    strictEqual(parseToolFilter(`edit(${("d/".repeat(90))})`).ok, false);
    strictEqual(parseToolFilter("bash(ls").ok, false);
    strictEqual(parseToolFilter("bash(ls))").ok, false);
  });
  it("splits a comma list, and fails the whole flag on one bad entry", () => {
    const ok1 = parseToolFilterList("read, search, bash(git status *)");
    strictEqual(ok1.ok, true);
    if (ok1.ok) deepStrictEqual(ok1.filters.map(describeToolFilter), ["read", "search", "bash(git status *)"]);
    strictEqual(parseToolFilterList("read, nope").ok, false);
  });
  it("TOOL_NAMES is the registry's key list — a new tool cannot hide from the filter", () => {
    deepStrictEqual([...TOOL_NAMES].sort(), Object.keys(TOOLS).sort());
  });
});

describe("tool filter matching", () => {
  const bash = (shape: string): ToolFilter => ({ tool: "bash", shape });

  it("a head-prefix shape covers the bare head and its args, never a lookalike", () => {
    const filter = bash("git status *");
    strictEqual(matchToolFilter([filter], "bash", "git status"), filter);
    strictEqual(matchToolFilter([filter], "bash", "git   status  -s"), filter);
    strictEqual(matchToolFilter([filter], "bash", "git statusfoo"), null);
    strictEqual(matchToolFilter([filter], "bash", "git status2 x"), null);
  });
  it("an exact-command shape matches only itself", () => {
    const filter = bash("ls -la");
    strictEqual(matchToolFilter([filter], "bash", "ls -la"), filter);
    strictEqual(matchToolFilter([filter], "bash", "ls -la x"), null);
  });
  it("a chained subject is never granted by any pattern", () => {
    strictEqual(normBashSubject("ls | curl evil"), null);
    strictEqual(matchToolFilter([bash("ls *")], "bash", "ls | curl evil"), null);
    strictEqual(matchToolFilter([bash("ls *")], "bash", "ls && rm -rf /"), null);
  });
  it("paths compare exactly (case-sensitive), backslashes folded", () => {
    const filter: ToolFilter = { tool: "edit", shape: "src/a.ts" };
    strictEqual(matchToolFilter([filter], "edit", "src/a.ts"), filter);
    strictEqual(matchToolFilter([filter], "edit", "src\\a.ts"), filter);
    strictEqual(matchToolFilter([filter], "edit", "src/a.ts.bak"), null);
    strictEqual(matchToolFilter([filter], "edit", "Src/a.ts"), null);
  });
  it("webfetch compares origins, so a sibling host cannot match on a prefix", () => {
    const filter: ToolFilter = { tool: "webfetch", shape: "https://docs.rs" };
    strictEqual(matchToolFilter([filter], "webfetch", "https://docs.rs/std/option/"), filter);
    strictEqual(matchToolFilter([filter], "webfetch", "https://docs.rs.evil.com/x"), null);
  });
  it("a whole-tool entry covers that tool only", () => {
    const filter: ToolFilter = { tool: "read", shape: null };
    strictEqual(matchToolFilter([filter], "read", "anything"), filter);
    strictEqual(matchToolFilter([filter], "search", "anything"), null);
    strictEqual(filtersToolEntirely([filter], "read"), true);
    strictEqual(filtersToolEntirely([{ tool: "read", shape: "x" }], "read"), false);
  });
  it("a run that cannot read or search cannot delegate (reading by proxy)", () => {
    strictEqual(delegationBlind([{ tool: "read", shape: null }]), true);
    strictEqual(delegationBlind([{ tool: "search", shape: null }]), true);
    strictEqual(delegationBlind([{ tool: "read", shape: "src/a.ts" }]), false);
    strictEqual(delegationBlind([]), false);
  });
  it("a bare disallow removes the spec; a shape-scoped one leaves it advertised", () => {
    const names = (disallowed: ToolFilter[]): string[] => toolSpecs(0, disallowed, undefined, true).map((s) => s.name);
    strictEqual(names([]).length, TOOL_NAMES.length);
    // ask_user is the one spec gated on a capability, not on a policy: with no
    // human at a keyboard it could only ever return its own refusal.
    ok(!toolSpecs(0, [], undefined, false).map((s) => s.name).includes("ask_user"));
    ok(!names([{ tool: "write", shape: null }]).includes("write"));
    ok(names([{ tool: "write", shape: "src/a.ts" }]).includes("write"));
    ok(!names([{ tool: "read", shape: null }, { tool: "search", shape: null }]).includes("read"));
  });
});

describe("composeSystemPrompt", () => {
  it("keeps the base prompt and puts the human's text last", () => {
    const out = composeSystemPrompt({ append: "Answer in haiku." });
    ok(out.startsWith("You are CodeWhip"), out.slice(0, 60));
    ok(out.endsWith("Answer in haiku."), out.slice(-40));
  });
  it("advertises the roster unless dynamic sections are excluded", () => {
    const withRoster = composeSystemPrompt({ roster: "- explore: find files" });
    ok(withRoster.includes("Delegable subagents"));
    ok(withRoster.includes("- explore: find files"));
    ok(!composeSystemPrompt({ roster: "- explore: find files", excludeDynamicSections: true }).includes("Delegable subagents"));
  });
  it("never drops the plan-mode refusal note — a prompt that hides a refusal gets it retried", () => {
    const out = composeSystemPrompt({ planMode: true, excludeDynamicSections: true, roster: "- explore: x" });
    ok(out.includes("PLAN MODE"));
    ok(!out.includes("Delegable subagents"));
    ok(composeSystemPrompt({ planMode: true, isChild: true }).includes("READ-ONLY SUBAGENT RUN"));
  });
  it("caps an appended block: it re-pays on every turn", () => {
    const out = composeSystemPrompt({ append: "x".repeat(APPEND_MAX_CHARS + 500) });
    strictEqual(out.endsWith("x".repeat(APPEND_MAX_CHARS)), true);
    ok(!out.includes("xxxxx\n\n"), "cap is the whole tail");
  });
});

/** One ask-class call through the loop, with the ask recorded. */
async function oneCall(
  runCwd: string,
  call: { name: string; args: unknown },
  opts: { yolo?: boolean; ask?: "yes" | "no"; allowed?: ToolFilter[]; disallowed?: ToolFilter[]; plan?: boolean }
): Promise<{ asks: number; trace: { policy: string; actor: string }[]; events: string[] }> {
  const asks: string[] = [];
  const { port } = makeFakePort([toolTurn(call.name, JSON.stringify(call.args)), textTurn("done")]);
  const events: string[] = [];
  const r = await agentLoop({
    prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5,
    yolo: opts.yolo ?? false, stdinIsTTY: true, port,
    askUser: async (q) => {
      asks.push(q);
      return opts.ask ?? "yes";
    },
    remembered: listRules(runCwd),
    planMode: opts.plan,
    allowedTools: opts.allowed,
    disallowedTools: opts.disallowed,
    onEvent: (e) => events.push(e.text),
  });
  return {
    asks: asks.length,
    trace: r.trace.map((t) => ({ policy: t.policy, actor: t.actor })),
    events,
  };
}

function tempCwd(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codewhip-filter-${tag}-`));
}

describe("loop: --allowed-tools is the session rung", () => {
  it("a matching write never reaches the prompt, and the run persists nothing", async () => {
    const runCwd = tempCwd("allow");
    const r = await oneCall(runCwd, { name: "write", args: { path: "notes.md", content: "hi\n" } }, {
      allowed: [{ tool: "write", shape: "notes.md" }],
    });
    strictEqual(r.asks, 0);
    deepStrictEqual(r.trace, [{ policy: "allow:default:write:ask+allowed-tools", actor: "human" }]);
    strictEqual(fs.readFileSync(path.join(runCwd, "notes.md"), "utf8"), "hi\n");
    strictEqual(fs.existsSync(path.join(runCwd, ".codewhip", "remembered.jsonl")), false);
  });
  it("the grant does not stretch to a sibling path", async () => {
    const runCwd = tempCwd("sibling");
    const r = await oneCall(runCwd, { name: "write", args: { path: "other.md", content: "hi\n" } }, {
      allowed: [{ tool: "write", shape: "notes.md" }],
    });
    strictEqual(r.asks, 1);
    strictEqual(r.trace[0]?.policy, "allow:default:write:ask");
    strictEqual(r.trace[0]?.actor, "human");
  });
  it("never outranks a policy deny: an allowlisted `rm -rf /` is still denied", async () => {
    const runCwd = tempCwd("denylist");
    const r = await oneCall(runCwd, { name: "bash", args: { command: "rm -rf /" } }, {
      allowed: [{ tool: "bash", shape: "rm -rf *" }],
    });
    strictEqual(r.asks, 0);
    ok(r.trace[0]?.policy.startsWith("deny:denylist:"), r.trace[0]?.policy ?? "");
  });
  it("never outranks --plan: an allowlisted edit is still refused", async () => {
    const runCwd = tempCwd("plan");
    const r = await oneCall(runCwd, { name: "edit", args: { path: "a.ts", oldString: "x", newString: "y" } }, {
      plan: true,
      allowed: [{ tool: "edit", shape: "a.ts" }],
    });
    deepStrictEqual(r.trace, [{ policy: "deny:plan:read-only", actor: "policy" }]);
  });
  it("never covers a self-protected path, even named bare", async () => {
    const runCwd = tempCwd("protected");
    const r = await oneCall(runCwd, { name: "write", args: { path: ".codewhip/key", content: "x\n" } }, {
      allowed: [{ tool: "write", shape: null }],
    });
    strictEqual(r.asks, 0);
    ok(r.trace[0]?.policy.endsWith("+allowed-tools-protected"), r.trace[0]?.policy ?? "");
  });
  it("is consulted before --yolo, so the audit says which flag granted it", async () => {
    const runCwd = tempCwd("yolo");
    const r = await oneCall(runCwd, { name: "write", args: { path: "notes.md", content: "hi\n" } }, {
      yolo: true,
      allowed: [{ tool: "write", shape: "notes.md" }],
    });
    strictEqual(r.trace[0]?.policy, "allow:default:write:ask+allowed-tools");
    const other = await oneCall(tempCwd("yolo2"), { name: "write", args: { path: "b.md", content: "hi\n" } }, {
      yolo: true,
      allowed: [{ tool: "write", shape: "notes.md" }],
    });
    strictEqual(other.trace[0]?.policy, "allow:default:write:ask+yolo");
  });
});

describe("loop: --disallowed-tools refuses above the ladder", () => {
  it("--yolo cannot grant a filtered-out bash shape", async () => {
    const runCwd = tempCwd("dis-yolo");
    const r = await oneCall(runCwd, { name: "bash", args: { command: "git push origin main" } }, {
      yolo: true,
      disallowed: [{ tool: "bash", shape: "git push *" }],
    });
    strictEqual(r.asks, 0);
    deepStrictEqual(r.trace, [{ policy: "deny:cli:disallowed", actor: "policy" }]);
    ok(r.events.some((e) => e.includes("cli:disallowed")), r.events.join("\n"));
  });
  it("a disallow beats an identical allow (fail closed)", async () => {
    const runCwd = tempCwd("both");
    const r = await oneCall(runCwd, { name: "write", args: { path: "notes.md", content: "hi\n" } }, {
      allowed: [{ tool: "write", shape: "notes.md" }],
      disallowed: [{ tool: "write", shape: "notes.md" }],
    });
    strictEqual(r.trace[0]?.policy, "deny:cli:disallowed");
    strictEqual(fs.existsSync(path.join(runCwd, "notes.md")), false);
  });
  it("a bare-tool disallow refuses even a fabricated call for the un-advertised tool", async () => {
    const runCwd = tempCwd("bare");
    const r = await oneCall(runCwd, { name: "webfetch", args: { url: "https://example.com" } }, {
      disallowed: [{ tool: "webfetch", shape: null }],
    });
    strictEqual(r.trace[0]?.policy, "deny:cli:disallowed");
  });
  it("killing read or search kills delegation too", async () => {
    const runCwd = tempCwd("blind");
    const r = await oneCall(runCwd, { name: "delegate", args: { agent: "explore", task: "find files" } }, {
      disallowed: [{ tool: "read", shape: null }],
    });
    strictEqual(r.trace[0]?.policy, "deny:cli:disallowed:delegate");
    ok(r.events.some((e) => e.includes("cli:disallowed:delegate")), r.events.join("\n"));
  });
});

describe("loop: system-prompt surface", () => {
  it("appends the operator's text after the harness prompt and roster", async () => {
    const runCwd = tempCwd("append");
    const { port, messagesSeen } = makeFakePort([textTurn("done")]);
    await agentLoop({
      prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 3, yolo: true,
      stdinIsTTY: false, port, remembered: listRules(runCwd),
      appendSystemPrompt: "STYLE: one sentence only.",
    });
    const system = messagesSeen[0]?.[0]?.content ?? "";
    ok(system.includes("STYLE: one sentence only."), system.slice(-120));
    ok(system.indexOf("STYLE") > system.indexOf("You are CodeWhip"), "appended after the base");
    ok(system.includes("Delegable subagents"), "roster still advertised by default");
  });
  it("excludes the roster on request, without touching the refusal notes", async () => {
    const runCwd = tempCwd("roster");
    const { port, messagesSeen } = makeFakePort([textTurn("done")]);
    await agentLoop({
      prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 3, yolo: true,
      stdinIsTTY: false, port, remembered: listRules(runCwd),
      excludeDynamicSections: true, planMode: true,
    });
    const system = messagesSeen[0]?.[0]?.content ?? "";
    ok(!system.includes("Delegable subagents"), system.slice(0, 120));
    ok(system.includes("PLAN MODE"));
  });
});

describe("filter identity", () => {
  it("logs the pattern as the human wrote it (normalized shape, real tool)", () => {
    strictEqual(describeToolFilter({ tool: "bash", shape: "git status *" }), "bash(git status *)");
    strictEqual(describeToolFilter({ tool: "read", shape: null }), "read");
  });
  it("an unmatched tool never borrows another tool's shape", () => {
    const filter: ToolFilter = { tool: "edit", shape: "a.ts" };
    strictEqual(matchToolFilter([filter], "write" as ToolName, "a.ts"), null);
    notEqual(filter.tool, "write");
  });
});

/** `parseRunArgs` sets exitCode on refusal — restore it, as headless-args does. */
function parse(args: string[]): ReturnType<typeof import("./index.js").parseRunArgs> {
  const before = process.exitCode;
  try {
    return parseRunArgsRef(args);
  } finally {
    process.exitCode = before;
  }
}

describe("CLI flags", () => {
  it("accepts a comma list, the camelCase alias, and the = form", () => {
    const o = parse(["--allowed-tools", "read,search", "--allowedTools=bash(git status *)", "go"]);
    ok(o !== null);
    deepStrictEqual(o.allowedTools, [
      { tool: "read", shape: null },
      { tool: "search", shape: null },
      { tool: "bash", shape: "git status *" },
    ]);
    deepStrictEqual(o.disallowedTools, []);
  });
  it("accumulates across repeats and caps the list", () => {
    const o = parse(["--allowed-tools", "read", "--allowed-tools", "search", "go"]);
    ok(o !== null);
    strictEqual(o.allowedTools.length, 2);
    strictEqual(parse(["--allowed-tools", Array.from({ length: 65 }, (_, i) => `edit(p${i}.ts)`).join(","), "go"]), null);
    strictEqual(parse(["--allowed-tools", Array.from({ length: 64 }, (_, i) => `edit(p${i}.ts)`).join(","), "go"])?.allowedTools.length, 64);
  });
  it("refuses the whole run on one malformed filter, naming it", () => {
    strictEqual(parse(["--disallowed-tools", "read, nope(x)", "go"]), null);
  });
  it("carries the prompt text and file path without reading the file at parse time", () => {
    const o = parse(["--append-system-prompt", "one line", "--append-system-prompt-file", "style.md", "go"]);
    ok(o !== null);
    strictEqual(o.appendSystemPrompt, "one line");
    strictEqual(o.appendSystemPromptFile, "style.md");
    strictEqual(parse(["--append-system-prompt", "x".repeat(APPEND_MAX_CHARS + 1), "go"]), null);
  });
  it("default the dynamic sections in, and never imply session persistence", () => {
    const o = parse(["--allowed-tools", "read", "go"]);
    ok(o !== null);
    strictEqual(o.excludeDynamicSections, false);
    strictEqual(o.persist, false);
    strictEqual(o.continue, false);
    strictEqual(parse(["--exclude-dynamic-system-prompt-sections", "go"])?.excludeDynamicSections, true);
  });
});
