import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/**
 * Core/surface boundary drift guard.
 *
 * The repo carries one architectural rule (the research-track boundary):
 * core modules — the agent loop, tools, policy, audit, outcomes, verdicts,
 * checkpoints, compaction, budgeting — must never depend on the product
 * surface (CLI, TUI, OpenAI-proxy serve, provider registry/wire stack,
 * reporting). Surface may import core, never the reverse. This keeps the
 * research substrate importable without the 136-provider table.
 *
 * Every non-test file under src/ (recursively) must appear in exactly one
 * list below; an unclassified new file fails the test on purpose.
 */

const SURFACE = new Set([
  "src/index.ts",
  "src/serve.ts",
  "src/auth.ts",
  "src/demo.ts",
  "src/provider.ts",
  "src/provider-registry.ts",
  "src/provider-blocklist.ts",
  "src/provider-stats.ts",
  "src/custom-providers.ts",
  "src/free-chain.ts",
  "src/free-providers.ts",
  "src/immunity/llm-run.ts",
  "src/models.ts",
  "src/onemin.ts",
  "src/router.ts",
  "src/run-output.ts",
  "src/metrics.ts",
  "src/model-allowlist.ts",
]);

const SURFACE_DIRS = new Set(["src/tui", "src/bench"]);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name).split(path.sep).join("/");
    if (entry.isDirectory()) out.push(...listSourceFiles(p));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function isSurface(file: string): boolean {
  return SURFACE.has(file) || SURFACE_DIRS.has(path.dirname(file));
}

function importedModules(file: string): string[] {
  const src = fs.readFileSync(file, "utf8");
  const specs = [...src.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1]);
  return specs
    .map((spec) => {
      let p = path.join(path.dirname(file), spec).split(path.sep).join("/");
      if (p.endsWith(".js")) p = p.slice(0, -3);
      return p + ".ts";
    })
    .filter((p) => fs.existsSync(p));
}

test("every src file is classified core or surface", () => {
  const unclassified = listSourceFiles("src").filter((f) => !isSurface(f) && !CORE_EXPECTED.has(f));
  assert.deepEqual(unclassified, [], `unclassified files (add to boundary.test.ts lists): ${unclassified.join(", ")}`);
});

/** Explicit core allowlist so a new file forces a boundary decision. */
const CORE_EXPECTED = new Set([
  "src/audit.ts",
  "src/budget.ts",
  "src/checkpoints.ts",
  "src/commands.ts",
  "src/compact.ts",
  "src/config-dir.ts",
  "src/eval-store.ts",
  "src/eval.ts",
  "src/frontmatter.ts",
  "src/hash.ts",
  "src/hooks.ts",
  "src/immunity/adversarial.ts",
  "src/immunity/baselines.ts",
  "src/immunity/cli.ts",
  "src/immunity/miner.ts",
  "src/immunity/rules.ts",
  "src/immunity/samples.ts",
  "src/immunity/simuser.ts",
  "src/loop.ts",
  "src/outcomes.ts",
  "src/pack.ts",
  "src/policy-store.ts",
  "src/policy.ts",
  "src/provider-port.ts",
  "src/redact.ts",
  "src/remember-store.ts",
  "src/remember.ts",
  "src/secure-file.ts",
  "src/settings.ts",
  "src/sessions.ts",
  "src/share.ts",
  "src/subagents.ts",
  "src/system.ts",
  "src/testkit/fakePort.ts",
  "src/tool-filter.ts",
  "src/verdict.ts",
  "src/wire-util.ts",
  "src/tools/background-status.ts",
  "src/tools/background-tasks.ts",
  "src/tools/background-tools.ts",
  "src/tools/background.ts",
  "src/tools/bash.ts",
  "src/tools/child-run.ts",
  "src/tools/delegate.ts",
  "src/tools/delegate_many.ts",
  "src/tools/edit.ts",
  "src/tools/jail.ts",
  "src/tools/read.ts",
  "src/tools/registry.ts",
  "src/tools/search-walk.ts",
  "src/tools/search.ts",
  "src/tools/shell-guard.ts",
  "src/tools/todo.ts",
  "src/tools/types.ts",
  "src/tools/webfetch-html.ts",
  "src/tools/webfetch.ts",
  "src/tools/write.ts",
]);

test("core never imports the surface", () => {
  const violations: string[] = [];
  for (const file of listSourceFiles("src")) {
    if (isSurface(file)) continue;
    for (const dep of importedModules(file)) {
      if (isSurface(dep)) violations.push(`${file} -> ${dep}`);
    }
  }
  assert.deepEqual(violations, [], `core/surface boundary violated:\n${violations.join("\n")}`);
});
