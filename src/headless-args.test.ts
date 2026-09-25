import test from "node:test";
import assert from "node:assert/strict";
import { parseRunArgs } from "./index.js";
import { setOutputFormat } from "./run-output.js";

/**
 * Wave-1 headless flags (docs/moat/20-parity-matrix.md GAP-1):
 * `-p`, `--output-format`, `--max-budget-usd`, and the `-` stdin prompt.
 */

function parse(args: string[]): ReturnType<typeof parseRunArgs> {
  const before = process.exitCode;
  try {
    return parseRunArgs(args);
  } finally {
    setOutputFormat(null);
    process.exitCode = before;
  }
}

test("-p arms headless text output without changing the prompt", () => {
  const o = parse(["-p", "fix", "the", "test"]);
  assert.ok(o !== null);
  assert.equal(o.prompt, "fix the test");
  assert.equal(o.headless, true);
  assert.equal(o.outputFormat, "text");
});

test("--headless is the long form of -p", () => {
  const o = parse(["--headless", "x"]);
  assert.ok(o !== null);
  assert.equal(o.headless, true);
});

test("--output-format implies -p and accepts space and = forms", () => {
  for (const args of [["--output-format", "json", "x"], ["--output-format=stream-json", "x"]] as const) {
    const o = parse([...args]);
    assert.ok(o !== null, args.join(" "));
    assert.equal(o.headless, true, args.join(" "));
    assert.equal(o.outputFormat, args[1] === "json" ? "json" : "stream-json");
  }
  assert.equal(parse(["--output-format", "yaml", "x"]), null, "rejects an unknown format");
  assert.equal(parse(["--output-format", "x"]), null, "needs a value");
});

test("headless output cannot share stdout with the TUI", () => {
  assert.equal(parse(["-p", "--tui", "x"]), null);
  assert.equal(parse(["--output-format", "json", "--tui", "x"]), null);
  // --no-tui only ever meant "plain stdout", so it stays legal alongside -p.
  assert.notEqual(parse(["-p", "--no-tui", "x"]), null);
});

test("--max-budget-usd validates the amount", () => {
  const o = parse(["-p", "--max-budget-usd", "0.5", "x"]);
  assert.ok(o !== null);
  assert.equal(o.maxBudgetUsd, 0.5);
  for (const bad of ["0", "-1", "abc", "10001"]) {
    assert.equal(parse(["--max-budget-usd", bad, "x"]), null, `rejects ${bad}`);
  }
  assert.equal(parse(["--max-budget-usd"]), null, "needs a value");
});

test("--max-budget-usd is refused on the never-billing free chain", () => {
  assert.equal(parse(["--free", "--max-budget-usd", "1", "x"]), null);
  assert.equal(parse(["--auto-failover", "--max-budget-usd", "1", "x"]), null);
});

test("- marks the prompt as coming from stdin", () => {
  const o = parse(["-", "-p"]);
  assert.ok(o !== null);
  assert.equal(o.prompt, "");
  assert.equal(o.stdinPrompt, true);
  assert.equal(o.headless, true);
  // `--print` still means the share block (a documented name collision with
  // another widely-used agent CLI).
  const s = parse(["--share", "--print", "x"]);
  assert.ok(s !== null);
  assert.equal(s.sharePrint, true);
  assert.equal(s.headless, false, "--print is not the headless flag");
});

test("interactive runs stay exactly as they were", () => {
  const o = parse(["fix", "the", "test", "--token-budget", "5000"]);
  assert.ok(o !== null);
  assert.equal(o.headless, false);
  assert.equal(o.stdinPrompt, false);
  assert.equal(o.outputFormat, "text");
  assert.equal(o.maxBudgetUsd, undefined);
});
