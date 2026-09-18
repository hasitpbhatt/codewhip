import { describe, it } from "node:test";
import { strictEqual, deepStrictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDERS as LIB_PROVIDERS,
  FREE_CHAIN as LIB_FREE_CHAIN,
  listBuiltinProviderIds,
  getProviderConfig,
} from "./providers.js";
import { PROVIDERS as CLI_PROVIDERS, PROVIDER_IDS } from "../provider-registry.js";
import { FREE_CHAIN as CLI_FREE_CHAIN } from "../free-chain.js";

/**
 * The lib once carried its own fork of the registry and free chain; it drifted
 * 20 providers and one prune behind the CLI and served library consumers wrong
 * defaults. These tests pin the facade to the CLI tables so the fork cannot
 * silently come back, and pin the "no node: builtins" property the Cloudflare
 * worker depends on (it imports src/lib precisely to avoid them).
 */

const SHARED_FIELDS = [
  "brand",
  "baseUrl",
  "chatPath",
  "modelsPath",
  "defaultModel",
  "envVar",
  "keyUrl",
  "timeoutMs",
] as const;

describe("lib registry facade", () => {
  it("exposes exactly the CLI's builtin ids, in registry order", () => {
    deepStrictEqual(listBuiltinProviderIds(), [...PROVIDER_IDS]);
  });

  it("matches the CLI row field-for-field for every builtin", () => {
    for (const id of PROVIDER_IDS) {
      const libRow = LIB_PROVIDERS[id];
      ok(libRow !== undefined, `lib PROVIDERS missing "${id}"`);
      const cliRow = CLI_PROVIDERS[id];
      for (const f of SHARED_FIELDS) {
        strictEqual(
          libRow[f],
          cliRow[f],
          `lib/CLI drift on "${id}".${f}: ${String(libRow[f])} !== ${String(cliRow[f])}`
        );
      }
    }
  });

  it("mirrors the CLI free chain exactly, order included", () => {
    deepStrictEqual(
      LIB_FREE_CHAIN.map((e) => e.id),
      CLI_FREE_CHAIN.map((e) => e.id)
    );
    for (let i = 0; i < LIB_FREE_CHAIN.length; i++) {
      strictEqual(LIB_FREE_CHAIN[i].freeOffer, CLI_FREE_CHAIN[i].freeOffer);
      strictEqual(LIB_FREE_CHAIN[i].limits, CLI_FREE_CHAIN[i].limits);
      strictEqual(LIB_FREE_CHAIN[i].keyNeeded, CLI_FREE_CHAIN[i].keyNeeded);
    }
  });

  it("serves lookups from the shared table (the nvidia default was the drift that mattered)", () => {
    const row = getProviderConfig("nvidia");
    ok(row !== undefined);
    strictEqual(row.defaultModel, CLI_PROVIDERS.nvidia.defaultModel);
    strictEqual(row.baseUrl, CLI_PROVIDERS.nvidia.baseUrl);
  });

  it("marks the onemin port so listModels can refuse a listing", () => {
    strictEqual(getProviderConfig("1min")?.port, "onemin");
  });
});

describe("lib stays Node-free (Workers bundle constraint)", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));

  /** Every file reachable from `start` by static/dynamic relative imports. */
  function importGraph(starts: string[], seen = new Set<string>()): string[] {
    const queue = [...starts];
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = fs.readFileSync(file, "utf8");
      const specs = [
        ...[...src.matchAll(/from\s+["'](\.[^"']+)["']/g)].map((m) => m[1]),
        ...[...src.matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)].map((m) => m[1]),
      ];
      for (const spec of specs) {
        const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, ".ts");
        if (fs.existsSync(target)) queue.push(target);
      }
    }
    return [...seen];
  }

  const libEntries = fs
    .readdirSync(here)
    .filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))
    .map((n) => path.join(here, n));

  it("imports no node: builtin anywhere in its graph", () => {
    const files = importGraph(libEntries);
    ok(files.length > 5, `graph unexpectedly small (${files.length} files) — traversal broken?`);
    const offenders = files.filter((f) => /from\s+["']node:|import\(\s*["']node:/.test(fs.readFileSync(f, "utf8")));
    deepStrictEqual(offenders, []);
  });

  it("shares the registry through the leaf, not a fork (no inline table here)", () => {
    // A re-forked table would reappear as object-literal provider rows in the
    // facade. The facade is allowed exactly one table-shaped assignment: the
    // fromEntries over the shared leaf.
    const src = fs.readFileSync(path.join(here, "providers.ts"), "utf8");
    ok(src.includes('from "../provider-registry.js"'), "facade must import the shared leaf");
    strictEqual((src.match(/baseUrl:\s*["']/g) ?? []).length, 0, "facade must not inline provider rows");
  });
});
