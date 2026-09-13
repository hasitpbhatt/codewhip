import * as fs from "node:fs";
import * as path from "node:path";
import { makePortForConfig } from "../provider.js";
import { getProviderConfig } from "../custom-providers.js";
import { resolveKey } from "../auth.js";
import { runBench } from "./runner.js";
import { renderAnalysis, readRecords } from "./analyze.js";
import { COMPILED_POLICY, PROMPT_POLICY_RULES, SEED_TASKS } from "./tasks.js";
import type { BenchArm } from "./types.js";

/**
 * Preset arms for the seed matrix. The substrate is the treatment; every
 * difference between arms maps to a documented ablation switch.
 */
export const PRESET_ARMS: BenchArm[] = [
  {
    // Compiled denies enforced harness-side, yolo armed so the ask ladder
    // never confounds the measurement: only policy blocks here.
    id: "harness-policy",
    policySurface: "harness",
    repeatGuard: true,
    yolo: true,
    ask: "deny",
    workspacePolicy: COMPILED_POLICY,
  },
  {
    // Same rule TEXT, surfaced in the prompt, harness denies disabled — the
    // RQ1 variable under test.
    id: "prompt-policy",
    policySurface: "prompt",
    repeatGuard: true,
    yolo: true,
    ask: "deny",
    promptPolicyRules: PROMPT_POLICY_RULES,
  },
  {
    // RQ2 approval-persistence: NO compiled policy, semi-attentive operator
    // (one fat-fingered `a`), two runs per cell reusing the workspace.
    id: "fatfinger",
    policySurface: "harness",
    repeatGuard: true,
    yolo: false,
    ask: "fatfinger-always",
  },
  {
    // RQ5 overthinking arm: repeat guard disabled.
    id: "no-repeat-guard",
    policySurface: "harness",
    repeatGuard: false,
    yolo: false,
    ask: "deny",
  },
];

export interface CliArgs {
  out: string;
  provider: string;
  model?: string;
  arms: string[];
  runsPerCell: number;
  limit?: number;
  list: boolean;
}

export function parseCliArgs(argv: string[]): CliArgs | { error: string } {
  const a: CliArgs = { out: "bench-results.jsonl", provider: "nvidia", arms: PRESET_ARMS.map((x) => x.id), runsPerCell: 1, list: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--out" && argv[i + 1] !== undefined) { a.out = argv[++i] as string; }
    else if (k === "--provider" && argv[i + 1] !== undefined) { a.provider = argv[++i] as string; }
    else if (k === "--model" && argv[i + 1] !== undefined) { a.model = argv[++i] as string; }
    else if (k === "--arms" && argv[i + 1] !== undefined) { a.arms = (argv[++i] as string).split(",").filter(Boolean); }
    else if (k === "--runs-per-cell" && argv[i + 1] !== undefined) { a.runsPerCell = Number(argv[++i]); }
    else if (k === "--limit" && argv[i + 1] !== undefined) { a.limit = Number(argv[++i]); }
    else if (k === "--list") { a.list = true; }
    else return { error: `unknown flag ${k}` };
  }
  if (!Number.isInteger(a.runsPerCell) || a.runsPerCell < 1 || a.runsPerCell > 10) {
    return { error: "--runs-per-cell must be an integer 1..10" };
  }
  return a;
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  if ("error" in parsed) {
    console.error(`bench: ${parsed.error}`);
    console.error("usage: npm run bench -- [--out file] [--provider id] [--model id] [--arms a,b] [--runs-per-cell n] [--limit n] [--list]");
    return 1;
  }
  if (parsed.list) {
    console.log(`arms: ${PRESET_ARMS.map((a) => a.id).join(", ")}`);
    console.log(`tasks: ${SEED_TASKS.map((t) => t.id).join(", ")}`);
    return 0;
  }
  const unknown = parsed.arms.filter((id) => !PRESET_ARMS.some((a) => a.id === id));
  if (unknown.length > 0) {
    console.error(`bench: unknown arms ${unknown.join(",")} (--list for presets)`);
    return 1;
  }
  const cfg = getProviderConfig(parsed.provider);
  if (cfg === null) {
    console.error(`bench: unknown provider "${parsed.provider}"`);
    return 1;
  }
  const { key } = resolveKey(parsed.provider);
  if (key.length === 0) {
    console.error(`bench: no key for ${parsed.provider} (codewhip auth login ${parsed.provider})`);
    return 1;
  }
  const model = parsed.model ?? cfg.defaultModel;
  const port = makePortForConfig(cfg, key);
  fs.mkdirSync(path.dirname(path.resolve(parsed.out)), { recursive: true });
  console.log(`bench: ${parsed.arms.length} arm(s) x ${SEED_TASKS.length} task(s) x ${parsed.runsPerCell} run(s) on ${parsed.provider}:${model} -> ${parsed.out}`);
  const summary = await runBench({
    tasks: SEED_TASKS,
    arms: PRESET_ARMS.filter((a) => parsed.arms.includes(a.id)),
    port,
    label: parsed.provider,
    model,
    outPath: parsed.out,
    runsPerCell: parsed.runsPerCell,
    limit: parsed.limit,
  });
  console.log(renderAnalysis(readRecords([parsed.out])));
  console.log(`summary: ${summary.runs} run(s) recorded`);
  return 0;
}
