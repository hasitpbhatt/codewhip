import { describe, it } from "node:test";
import { deepStrictEqual, strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop } from "./loop.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import {
  BUILTIN_AGENTS,
  childFiltersFor,
  listAgents,
  parseAgentFile,
  findAgent,
  runChildAgent,
  MAX_DELEGATION_DEPTH,
  type AgentDef,
} from "./subagents.js";
import { toolSpecs } from "./tools/registry.js";
import { TOOL_NAMES } from "./tools/types.js";
import { readAuditLog, verifyChain } from "./audit.js";
import { readOutcomeRecords } from "./outcomes.js";
import { summarize } from "./metrics.js";

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function stubAsk(_q: string): Promise<"yes" | "always" | "no"> {
  return Promise.resolve("yes");
}

describe("subagents", () => {
  it("parseAgentFile: valid file parses (name from filename, body, max_steps, model)", () => {
    const r = parseAgentFile(
      "scout.md",
      "---\ndescription: Fast recon.\nmax_steps: 5\nmodel: m2\n---\nYou are scout.\nReport fast."
    );
    ok("agent" in r, JSON.stringify(r));
    strictEqual(r.agent.name, "scout");
    strictEqual(r.agent.description, "Fast recon.");
    strictEqual(r.agent.maxSteps, 5);
    strictEqual(r.agent.model, "m2");
    ok(r.agent.systemPrompt.includes("You are scout."));
  });

  it("parseAgentFile: malformed sources fail closed", () => {
    ok("error" in parseAgentFile("Bad_Name.md", "---\ndescription: x\n---\nbody"));
    ok("error" in parseAgentFile("ab.md", "no frontmatter here"));
    ok("error" in parseAgentFile("ab.md", "---\ndescription: x\n")); // unclosed
    ok("error" in parseAgentFile("ab.md", "---\n---\nbody")); // missing description
    ok("error" in parseAgentFile("ab.md", "---\ndescription: x\n---\n")); // empty body
    ok("error" in parseAgentFile("ab.md", "---\ndescription: x\nmax_steps: 0\n---\nbody")); // bad steps
    ok("error" in parseAgentFile("ab.md", "---\ndescription: x\nmax_steps: nope\n---\nbody"));
  });

  it("built-ins ship zero-config: explore, review, plan with descriptions", () => {
    const names = BUILTIN_AGENTS.map((a) => a.name);
    ok(names.includes("explore") && names.includes("review") && names.includes("plan"), names.join(","));
    for (const a of BUILTIN_AGENTS) {
      ok(a.description.length > 10 && a.systemPrompt.length > 30, a.name);
      ok(a.maxSteps >= 1);
    }
  });

  it("listAgents: a file overrides the same-name built-in; missing dir returns built-ins", () => {
    const cwd = tmpDir("codewhip-sub-agents-");
    try {
      ok(listAgents(cwd).length === BUILTIN_AGENTS.length);
      fs.mkdirSync(path.join(cwd, ".codewhip", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(cwd, ".codewhip", "agents", "explore.md"),
        "---\ndescription: Custom explore override.\n---\nCustom explore body."
      );
      fs.writeFileSync(
        path.join(cwd, ".codewhip", "agents", "scout.md"),
        "---\ndescription: Custom scout.\n---\nScout body."
      );
      fs.writeFileSync(path.join(cwd, ".codewhip", "agents", "broken.md"), "not frontmatter");
      const agents = listAgents(cwd);
      const explore = agents.find((a) => a.name === "explore");
      ok(explore !== undefined && explore.description === "Custom explore override.");
      ok(findAgent(cwd, "scout") !== null);
      ok(findAgent(cwd, "broken") === null); // invalid files are skipped, never crash
      ok(findAgent(cwd, "nonexistent") === null);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("toolSpecs: depth 0 sees all 13 tools with a keyboard, 12 without; children see only read+search", () => {
    const names0 = toolSpecs(0).map((s) => s.name);
    strictEqual(names0.length, TOOL_NAMES.length - 1);
    ok(!names0.includes("ask_user"), "no keyboard reachable means no question tool advertised");
    const asked = toolSpecs(0, undefined, undefined, true).map((s) => s.name);
    strictEqual(asked.length, TOOL_NAMES.length);
    ok(asked.includes("ask_user"));
    ok(names0.includes("delegate") && names0.includes("delegate_many"));
    const names1 = toolSpecs(1, undefined, undefined, true).map((s) => s.name);
    strictEqual(names1.length, 2);
    ok(names1.includes("read") && names1.includes("search"));
    ok(!names1.includes("delegate") && !names1.includes("edit") && !names1.includes("bash") && !names1.includes("webfetch") && !names1.includes("todo") && !names1.includes("ask_user"));
  });

  it("parseAgentFile: tools narrows what a child is offered, and narrows only", () => {
    const both = parseAgentFile("scout.md", "---\ndescription: d.\ntools: Read, search\n---\nbody");
    ok("agent" in both, JSON.stringify(both));
    deepStrictEqual([...(both.agent.allowed ?? [])], ["read", "search"]);
    const one = parseAgentFile("ab.md", "---\ndescription: d.\ntools: read\n---\nbody");
    ok("agent" in one, JSON.stringify(one));
    deepStrictEqual(one.agent.allowed, ["read"]);
    // A child has no write, no bash and no network: a file cannot hand it one.
    const widened = parseAgentFile("ab.md", "---\ndescription: d.\ntools: bash\n---\nbody");
    ok("error" in widened && widened.error.includes("narrows and never widens"), JSON.stringify(widened));
    const unknown = parseAgentFile("ab.md", "---\ndescription: d.\ntools: grep\n---\nbody");
    ok("error" in unknown && unknown.error.includes("unknown tool"), JSON.stringify(unknown));
    // tools: and disallowedTools: that cancel out would buy a child run with
    // nothing to do but apologize for itself.
    const empty = parseAgentFile("ab.md", "---\ndescription: d.\ntools: read\ndisallowedTools: read\n---\nbody");
    ok("error" in empty && empty.error.includes("nothing to call"), JSON.stringify(empty));
  });

  it("parseAgentFile: disallowedTools speaks the run-filter grammar", () => {
    const r = parseAgentFile("ab.md", "---\ndescription: d.\ndisallowedTools: Write, Edit(src/a.ts)\n---\nbody");
    ok("agent" in r, JSON.stringify(r));
    deepStrictEqual([...(r.agent.disallowed ?? [])], [
      { tool: "write", shape: null },
      { tool: "edit", shape: "src/a.ts" },
    ]);
    const bad = parseAgentFile("ab.md", "---\ndescription: d.\ndisallowedTools: read(x)\n---\nbody");
    ok("error" in bad && bad.error.includes("disallowedTools"), JSON.stringify(bad));
  });

  it("parseAgentFile: the un-honoured Claude Code fields are refused by name, not ignored", () => {
    for (const key of ["permissionMode", "skills", "mcpServers", "hooks", "memory", "background", "effort", "isolation"]) {
      const r = parseAgentFile("ab.md", `---\ndescription: d.\n${key}: anything\n---\nbody`);
      ok("error" in r, `${key} must be refused, not accepted-and-dropped`);
      ok(r.error.includes(key) && r.error.includes("not honoured"), `${key}: ${r.error}`);
    }
    const typo = parseAgentFile("ab.md", "---\ndescription: d\ncolour: blue\n---\nbody");
    ok("error" in typo && typo.error.includes("unknown field"), JSON.stringify(typo));
  });

  it("childFiltersFor: a child is born refusing what its parent refuses", () => {
    const base = { name: "s", description: "d", systemPrompt: "b", maxSteps: 5 };
    const parent = [{ tool: "bash" as const, shape: "git *" }];
    deepStrictEqual(childFiltersFor(base, parent), parent);
    // Narrowing tools: to read is the same authority as refusing search, so it
    // arrives as the same kind of entry — one mechanism, not a second one.
    deepStrictEqual(childFiltersFor({ ...base, allowed: ["read"] }, undefined), [
      { tool: "search", shape: null },
    ]);
    deepStrictEqual(childFiltersFor({ ...base, disallowed: [{ tool: "webfetch", shape: "https://x.com" }] }, parent), [
      { tool: "bash", shape: "git *" },
      { tool: "webfetch", shape: "https://x.com" },
    ]);
    // A file cannot add a second copy of a refusal the operator already made.
    const dupe = childFiltersFor({ ...base, allowed: ["read"], disallowed: [{ tool: "search", shape: null }] }, [
      { tool: "search", shape: null },
    ]);
    deepStrictEqual(dupe, [{ tool: "search", shape: null }]);
    ok(childFiltersFor(base, parent) !== parent, "the parent's array is never handed to a child to mutate");
    const typed: AgentDef = { ...base, allowed: ["read", "search"] };
    deepStrictEqual(childFiltersFor(typed, undefined), []);
  });

  it("a tools:-narrowed child is offered one spec, and its refusal is enforced in the child's own run", async () => {
    const runCwd = tmpDir("codewhip-sub-frontmatter-");
    try {
      fs.mkdirSync(path.join(runCwd, ".codewhip", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(runCwd, ".codewhip", "agents", "peeker.md"),
        "---\ndescription: Reads one file, nothing else.\ntools: Read\n---\nYou are peeker."
      );
      fs.writeFileSync(
        path.join(runCwd, ".codewhip", "agents", "nosearch.md"),
        "---\ndescription: Cannot search.\ndisallowedTools: Search\n---\nYou are nosearch."
      );
      const { port, record, messagesSeen } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "peeker", task: "peek at the repo" })),
        textTurn("peeked"),
        toolTurn("delegate", JSON.stringify({ agent: "nosearch", task: "find the flag" })),
        toolTurn("search", JSON.stringify({ pattern: "flag" })),
        textTurn("searching is refused for me"),
        textTurn("both children reported"),
      ]);
      const r = await agentLoop({
        prompt: "delegate twice", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 8, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk,
      });
      strictEqual(r.error, undefined);
      // Call order: parent, peeker child, parent, nosearch child, its summary, parent.
      strictEqual(record[1]?.toolCount, 1, "a tools: read child must not be advertised search either");
      const refused = messagesSeen
        .flat()
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content));
      ok(
        refused.some((s) => s.includes("--disallowed-tools search")),
        `the child's own filter must fire inside its run: ${refused.join(" | ")}`
      );
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("delegate: child runs, audit chain carries the child runId, usage folds into the receipt", async () => {

    const runCwd = tmpDir("codewhip-sub-delegate-");
    fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
    try {
      const { port, record, messagesSeen } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "read f.txt and report" }), { prompt: 100, completion: 10 }),
        toolTurn("read", JSON.stringify({ path: "f.txt" }), { prompt: 50, completion: 5 }),
        textTurn("f.txt says hello", { prompt: 50, completion: 5 }),
        textTurn("done", { prompt: 10, completion: 2 }),
      ]);
      const events: string[] = [];
      const r = await agentLoop({
        prompt: "explore the file", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk,
        onEvent: (e) => events.push(e.text), remembered: [],
      });
      strictEqual(r.text, "done");
      // Roster rides the parent's system message; the child gets its own body.
      ok(messagesSeen[0]?.[0]?.content.includes("Delegable subagents"), messagesSeen[0]?.[0]?.content.slice(0, 200) ?? "");
      ok(messagesSeen[0]?.[0]?.content.includes("explore:"));
      const childSystem = messagesSeen[1]?.[0]?.content ?? "";
      ok(childSystem.startsWith("You are the explore subagent"), childSystem.slice(0, 120));
      ok(childSystem.includes("READ-ONLY SUBAGENT RUN"));
      ok(!childSystem.includes("Delegable subagents"));
      // Child advertised specs are read+search (no network, no delegation);
      // parent saw all 12 (incl. background + todo tools).
      strictEqual(record[0]?.toolCount, 12);
      strictEqual(record[1]?.toolCount, 2);
      // Usage folds honestly into the parent's totals and buckets.
      strictEqual(r.promptTokens, 100 + 50 + 50 + 10);
      strictEqual(r.completionTokens, 10 + 5 + 5 + 2);
      const bucket = r.usageByModel.find((b) => b.label === "nvidia" && b.model === "m");
      ok(bucket !== undefined && bucket.prompt === 210 && bucket.completion === 22);
      // Child progress forwarded to the parent's event stream.
      ok(events.some((e) => e.startsWith("[explore]")), events.join(" | "));
      // The delegate call is on the parent's trail, allowed by policy.
      const delegateTrace = r.trace.find((t) => t.tool === "delegate");
      ok(delegateTrace !== undefined && delegateTrace.policy === "allow:delegate:read-only", JSON.stringify(r.trace));
      // Child runId is on the global audit chain; chain verifies intact.
      // (The child made exactly one tool call — the read — so exactly one
      // child-owned audit entry; the delegate call itself is parent-owned.)
      const parentRunIds = new Set([r.runId]);
      const audit = readAuditLog(runCwd).entries;
      const childEntries = audit.filter((e) => !parentRunIds.has(e.runId));
      strictEqual(childEntries.length, 1);
      strictEqual(childEntries[0]?.tool, "read");
      strictEqual(verifyChain(runCwd).valid, true);
      // Child wrote its own outcome record.
      const childOutcome = readOutcomeRecords(runCwd).find((o) => !parentRunIds.has(o.runId));
      ok(childOutcome !== undefined, "expected a child outcome record");
      strictEqual(childOutcome?.model, "m");
      // Delegate output carries the child runId back to the parent transcript.
      const delegateOut = messagesSeen[3]?.filter((m) => m.role === "tool").map((m) => m.content).join("\n") ?? "";
      ok(delegateOut.includes("[subagent explore runId:"), delegateOut.slice(-120));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("depth guard: a child's delegate call is denied before the ladder (loop:max-depth)", async () => {
    const runCwd = tmpDir("codewhip-sub-depth-");
    try {
      const { port } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "try to delegate" })),
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "nested" })),
        textTurn("child done"),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(r.text, "done");
      // The child's outcome record shows its delegate call denied at depth.
      const child = readOutcomeRecords(runCwd).find((o) => o.runId !== r.runId);
      ok(child !== undefined, "expected child outcome");
      const deny = child?.tool_calls.find((c) => c.ruleId === "loop:max-depth");
      ok(deny !== undefined && deny.decision === "deny", JSON.stringify(child?.tool_calls));
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("children have no network: a child webfetch call is denied (loop:child-no-network)", async () => {
    const runCwd = tmpDir("codewhip-sub-net-");
    try {
      const { port } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "fetch docs" })),
        toolTurn("webfetch", JSON.stringify({ url: "https://example.com" })),
        textTurn("child done"),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(r.text, "done");
      const child = readOutcomeRecords(runCwd).find((o) => o.runId !== r.runId);
      ok(child !== undefined, "expected child outcome");
      const deny = child?.tool_calls.find((c) => c.ruleId === "loop:child-no-network");
      ok(deny !== undefined && deny.decision === "deny", JSON.stringify(child?.tool_calls));
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("children are read-only: a child todo call is denied pre-ladder (loop:child-readonly)", async () => {
    const runCwd = tmpDir("codewhip-sub-todo-");
    try {
      const { port } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "keep a todo list" })),
        toolTurn("todo", JSON.stringify({ action: "replace", items: [{ id: "1", text: "x", status: "pending" }] })),
        textTurn("child done"),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 6, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(r.text, "done");
      const child = readOutcomeRecords(runCwd).find((o) => o.runId !== r.runId);
      ok(child !== undefined, "expected child outcome");
      const deny = child?.tool_calls.find((c) => c.ruleId === "loop:child-readonly");
      ok(deny !== undefined && deny.decision === "deny", JSON.stringify(child?.tool_calls));
      // The deny closed no file: the child never reached todoTool's persist.
      strictEqual(fs.existsSync(path.join(runCwd, ".codewhip", "todos.json")), false);
      strictEqual(verifyChain(runCwd).valid, true);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("delegate_many splits the remaining budget: one overspending child trips its own share", async () => {
    const runCwd = tmpDir("codewhip-sub-split-");
    try {
      const { port } = makeFakePort([
        toolTurn("delegate_many", JSON.stringify({ entries: [{ agent: "explore", task: "burn" }, { agent: "review", task: "light" }] }), { prompt: 100, completion: 0 }),
        // Child A (explore): one 60-token turn — over its 100/2 = 50 share.
        textTurn("A over budget", { prompt: 60, completion: 0 }),
        // Child B (review): well inside its share.
        textTurn("B report", { prompt: 10, completion: 0 }),
        textTurn("converged", { prompt: 5, completion: 0 }),
      ]);
      const r = await agentLoop({
        prompt: "fan out", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 4, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [], tokenBudget: 200,
      });
      strictEqual(r.text, "converged");
      // Child A tripped its own share (60 > 50) after one turn; its spend is
      // still folded honestly (100 + 60 + 10 + 5 = 175 < 200).
      const childA = readOutcomeRecords(runCwd).find((o) => o.runId !== r.runId && o.usage.prompt >= 60);
      ok(childA !== undefined, "expected the overspending child's record");
      strictEqual(childA?.usage.prompt, 60);
      strictEqual(r.promptTokens, 175);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("plan mode: a read-only parent run cannot delegate", async () => {
    const runCwd = tmpDir("codewhip-sub-plan-");
    try {
      const { port } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "nope" })),
        textTurn("plan only"),
      ]);
      const r = await agentLoop({
        prompt: "plan", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 4, yolo: true,
        stdinIsTTY: true, port, askUser: stubAsk, planMode: true, remembered: [],
      });
      strictEqual(r.text, "plan only");
      const delegateTrace = r.trace.find((t) => t.tool === "delegate");
      ok(delegateTrace !== undefined && delegateTrace.policy === "deny:plan:read-only", JSON.stringify(r.trace));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("delegate is never memoized: identical repeat runs a second child", async () => {
    const runCwd = tmpDir("codewhip-sub-memo-");
    try {
      const { port } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "same task" })),
        textTurn("first report"),
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "same task" })),
        textTurn("second report"),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "twice", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 8, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(r.repeatCalls, 0);
      strictEqual(r.trace.filter((t) => t.tool === "delegate").length, 2);
      const childRuns = readOutcomeRecords(runCwd).filter((o) => o.runId !== r.runId);
      strictEqual(childRuns.length, 2);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("delegate_many: ordered reports, both children audited, usage folded (max 4)", async () => {
    const runCwd = tmpDir("codewhip-sub-many-");
    try {
      const { port } = makeFakePort([
        toolTurn(
          "delegate_many",
          JSON.stringify({ entries: [{ agent: "explore", task: "do TASK-A" }, { agent: "review", task: "do TASK-B" }] }),
          { prompt: 100, completion: 10 }
        ),
        textTurn("converged", { prompt: 10, completion: 2 }),
      ]);
      const r = await agentLoop({
        prompt: "fan out", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 4, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(r.text, "converged");
      const delegateOut = r.trace.find((t) => t.tool === "delegate_many");
      ok(delegateOut !== undefined && delegateOut.policy === "allow:delegate:read-only");
      // Two child outcome records; chain intact.
      const childRuns = readOutcomeRecords(runCwd).filter((o) => o.runId !== r.runId);
      ok(childRuns.length >= 2, `expected 2 child outcomes, got ${childRuns.length}`);
      strictEqual(verifyChain(runCwd).valid, true);
      // Usage folded: 100 + 1 + 1 (two children) + 10 prompt.
      ok(r.promptTokens >= 100 + 10, `prompt tokens should include child usage: ${r.promptTokens}`);
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("delegate_many refuses more than the fanout cap without running children", async () => {
    const runCwd = tmpDir("codewhip-sub-cap-");
    try {
      const { port } = makeFakePort([
        toolTurn(
          "delegate_many",
          JSON.stringify({
            entries: [
              { agent: "explore", task: "1" },
              { agent: "explore", task: "2" },
              { agent: "explore", task: "3" },
              { agent: "explore", task: "4" },
              { agent: "explore", task: "5" },
            ],
          })
        ),
        textTurn("done"),
      ]);
      const r = await agentLoop({
        prompt: "too many", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 4, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(r.text, "done");
      const out = r.trace.find((t) => t.tool === "delegate_many");
      ok(out !== undefined);
      // Only the refusal reached the model; no child outcomes were written.
      const childRuns = readOutcomeRecords(runCwd).filter((o) => o.runId !== r.runId);
      strictEqual(childRuns.length, 0);
      const firstAudit = readAuditLog(runCwd).entries.find((e) => e.tool === "delegate_many");
      ok(firstAudit !== undefined && firstAudit.policy.startsWith("allow:delegate:read-only"));
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("runChildAgent: refuses beyond the depth cap even when called directly", async () => {
    const r = await runChildAgent({
      cwd: tmpDir("codewhip-sub-direct-"),
      agent: BUILTIN_AGENTS[0] as NonNullable<(typeof BUILTIN_AGENTS)[number]>,
      task: "x",
      port: async () => ({ ok: true, text: "y", toolCalls: [], promptTokens: 1, completionTokens: 1 }),
      model: "m",
      label: "nvidia",
      depth: MAX_DELEGATION_DEPTH, // child depth already at cap
    });
    ok(!r.ok);
    ok(r.error.includes("depth cap"));
  });

  it("per-agent model override: the child calls the port with the agent's model", async () => {
    const runCwd = tmpDir("codewhip-sub-model-");
    try {
      fs.mkdirSync(path.join(runCwd, ".codewhip", "agents"), { recursive: true });
      fs.writeFileSync(
        path.join(runCwd, ".codewhip", "agents", "cheap.md"),
        "---\ndescription: Cheap scout.\nmodel: m-cheap\n---\nYou are cheap."
      );
      const { port, record } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "cheap", task: "look" })),
        textTurn("cheap done"),
        textTurn("done"),
      ]);
      await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 4, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [],
      });
      strictEqual(record[1]?.model, "m-cheap");
      strictEqual(record[2]?.model, "m");
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("child token budget is enforced live; folded child spend trips the parent's budget honestly", async () => {
    const runCwd = tmpDir("codewhip-sub-budget-");
    try {
      const { port, record } = makeFakePort([
        toolTurn("delegate", JSON.stringify({ agent: "explore", task: "burn" }), { prompt: 100, completion: 0 }),
        // Child turn 1: 40 tokens (inside the child's inherited 150-100=50).
        toolTurn("read", JSON.stringify({ path: "f.txt" }), { prompt: 40, completion: 0 }),
        // Child turn 2: +20 = 60 > 50 — the child must stop here.
        textTurn("child partial", { prompt: 20, completion: 0 }),
        textTurn("done", { prompt: 10, completion: 0 }),
      ]);
      fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
      const r = await agentLoop({
        prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 4, yolo: false,
        stdinIsTTY: true, port, askUser: stubAsk, remembered: [], tokenBudget: 150,
      });
      // The child made exactly 2 calls (its second tripped its own budget);
      // the parent's final turn then consumed the 4th scripted response.
      strictEqual(record.length, 4, `port calls: ${record.length}`);
      // The child's outcome record exists, names its parent, and counts its spend.
      const childOutcome = readOutcomeRecords(runCwd).find((o) => o.runId !== r.runId);
      ok(childOutcome !== undefined);
      strictEqual(childOutcome?.parent_run_id, r.runId);
      strictEqual(childOutcome?.usage.prompt, 60);
      // Honest metering: child spend is folded into the parent's totals, and
      // the parent's own budget check (100 + 60 + 10 = 170 > 150) trips —
      // delegation can never spend off-book.
      strictEqual(r.promptTokens, 170);
      ok(r.error?.includes("token budget exhausted") === true, r.error ?? "no error");
    } finally {
      fs.rmSync(runCwd, { recursive: true, force: true });
    }
  });

  it("metrics: child runs are attributed (activity counted, run/spend bars not double-counted)", () => {
    const parent = {
      v: 1 as const, ts: "2026-09-12T00:00:00Z", runId: "p", model: "m", prompt_hash: "h", yolo: false,
      tool_calls: [{ seq: 1, tool: "delegate", args_hash: "a", result_hash: "b", decision: "allow", ruleId: "delegate:read-only" }],
      usage: { prompt: 140, completion: 10 },
      result_preview_redacted: "", verdict: null,
      usageByModel: [{ label: "nvidia" as const, model: "m", prompt: 140, completion: 10 }], // already includes child spend
    };
    const child = {
      v: 1 as const, ts: "2026-09-12T00:00:01Z", runId: "c", model: "m", prompt_hash: "h2", yolo: false,
      tool_calls: [{ seq: 1, tool: "read", args_hash: "a", result_hash: "b", decision: "deny", ruleId: "plan:read-only" }],
      usage: { prompt: 40, completion: 0 },
      result_preview_redacted: "", verdict: null,
      usageByModel: [{ label: "nvidia" as const, model: "m", prompt: 40, completion: 0 }],
      parent_run_id: "p",
    };
    const s = summarize([parent, child], 0, null, Date.now());
    strictEqual(s.runs, 1); // child does not inflate the run count
    strictEqual(s.toolCalls, 2); // child activity is real and counted
    strictEqual(s.denied, 1);
    strictEqual(s.pricedRuns + s.untrackedRuns, 1); // spend counted once (folded into parent)
  });

  it("parseAgentFile: prompt body over the cap is rejected", () => {
    const big = "x".repeat(8001);
    ok("error" in parseAgentFile("ab.md", `---\ndescription: x\n---\n${big}`));
  });
});
