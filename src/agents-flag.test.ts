import test from "node:test";
import assert from "node:assert/strict";
import { parseRunArgs } from "./index.js";
import { CHILD_DEFAULT_MAX_STEPS } from "./subagents.js";
import { PROVIDERS } from "./provider.js";

/**
 * Wave 3f CLI surface (docs/moat/20-parity-matrix.md row `--agents` JSON,
 * `--agent`): both flags are resolved at argument-parse time, so a roster that
 * cannot be honoured stops the run before a token is spent. The roster's own
 * rules are tested in `subagents.test.ts`; the shaping of a main-thread agent
 * is `mainThreadTurn`, tested there too. What is pinned here is the seam: what
 * the flags accept, and what they refuse out loud.
 */

function parse(args: string[]): ReturnType<typeof parseRunArgs> {
  const before = process.exitCode;
  try {
    return parseRunArgs(args);
  } finally {
    process.exitCode = before;
  }
}

const SCOUT = '{"scout":{"description":"Recon the tree.","prompt":"You are scout."}}';

test("--agents adds a roster entry with the file type's defaults", () => {
  const o = parse(["--agents", SCOUT, "go"]);
  assert.ok(o !== null);
  assert.deepEqual(o.agents, [{
    name: "scout",
    description: "Recon the tree.",
    systemPrompt: "You are scout.",
    maxSteps: CHILD_DEFAULT_MAX_STEPS,
  }]);
  assert.equal(o.agent, undefined);
});

test("--agents accepts --agents=<json> and an empty roster is not an error", () => {
  const eq = parse([`--agents=${SCOUT}`, "go"]);
  assert.ok(eq !== null);
  assert.equal(eq.agents?.[0]?.name, "scout");
  const empty = parse(["--agents", "{}", "go"]);
  assert.ok(empty !== null);
  assert.deepEqual(empty.agents, []);
});

test("--agents refuses a payload that would silently lose an entry", () => {
  // Each of these is a roster that would LOAD and then not contain what the
  // operator typed, which surfaces much later as `unknown agent "…"`.
  for (const bad of ["nope", "[]", '{"s":{"description":"d."}}', '{"s":{"description":"d.","prompt":"p","permissionMode":"yolo"}}', '{"Bad Name":{"description":"d.","prompt":"p"}}']) {
    assert.equal(parse(["--agents", bad, "go"]), null, bad);
  }
});

test("--agent names the entry this run acts as", () => {
  const o = parse(["--agent", "explore", "--agents", SCOUT, "go"]);
  assert.ok(o !== null);
  assert.equal(o.agent, "explore");
  assert.equal(o.agents?.length, 1);
  assert.equal(parse(["--agent=review", "go"])?.agent, "review");
});

test("the two flags never match each other's spelling", () => {
  assert.equal(parse(["--agent", "--model", "m", "go"]), null, "a flag where the name belongs is a missing value, not a name");
  assert.equal(parse(["--agent"]), null);
  assert.equal(parse(["--agents"]), null);
  assert.equal(parse(["--agent", "one", "--agent", "two", "go"]), null, "one run is one agent");
  const eq = parse(["--agents={}", "go"]);
  assert.ok(eq !== null);
  assert.equal(eq.agent, undefined, "--agents=… is not --agent with an s left over");
});

test("--agent never claims to be --model: modelExplicit stays false until the human types one", () => {
  // `--agent` is the only flag that can change which model the run uses without
  // the human naming one (an agent file may pin one). It arrives with
  // modelExplicit: false by design, and cmdRun must keep it that way: driving
  // resolveRoute through the model parameter instead of a `pin` makes the
  // router skip class routing, which is how a private-class prompt once
  // reached a cloud provider under "explicit override" (regression 2026-10-11,
  // covered end-to-end by the built CLI — cmdRun is not unit-driven,
  // session-naming.test.ts:27 — and by the `pin` cases in router.test.ts).
  const opts = parse(["--agent", "review", "go"]);
  assert.ok(opts !== null);
  assert.equal(opts.modelExplicit, false, "the entry's pin is not the human's --model");
  assert.equal(opts.model, PROVIDERS.nvidia.defaultModel, "the routed default survives; the pin rides resolveRoute");
  // ...and the shorthand that actually means it still works.
  assert.equal(parse(["--agent", "review", "--model", "m", "go"])?.modelExplicit, true);
});
