import { getProviderConfig } from "../custom-providers.js";
import { resolveKey } from "../auth.js";
import { makePortForConfig } from "../provider.js";
import { readLabeledEvents } from "./samples.js";
import { DEFAULT_MINER, evaluateRules, mineRules } from "./miner.js";
import { evaluateJudge, llmJudge, llmPolicyRules } from "./baselines.js";
import { simulateCorpus } from "./simuser.js";

/**
 * Surface runner for the LLM comparison arms:
 *   npx tsx src/immunity/llm-run.ts --provider <id> [--model m] [--sim [runs] [--seed N] | cwd]
 * Prints the miner arms and the two LLM baselines on the same labeled
 * stream with token receipts. Lives on the surface side because it wires a
 * real provider; baselines.ts itself stays core (pure ChatPort).
 */
const argv = process.argv.slice(2);
function flag(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] ?? null : null;
}

const provider = flag("--provider");
if (provider === null) {
  console.error("usage: llm-run --provider <id> [--model m] [--sim [runs] [--seed N] | cwd]");
  process.exitCode = 1;
} else {
  const cfg = getProviderConfig(provider);
  const { key } = cfg === null ? { key: "" } : resolveKey(provider);
  if (cfg === null || key.length === 0) {
    console.error(`llm-run: unknown provider "${provider}" or no key resolved`);
    process.exitCode = 1;
    process.exit();
  }
  const model = flag("--model") ?? cfg.defaultModel ?? "";
  const port = makePortForConfig(cfg, key);
  const simIdx = argv.indexOf("--sim");
  const events =
    simIdx >= 0
      ? simulateCorpus({ seed: Number(flag("--seed") ?? "") || 7, runs: Number(argv[simIdx + 1] ?? "") || 300 })
      : readLabeledEvents(argv.find((a) => !a.startsWith("--") && a !== provider && a !== model) ?? process.cwd());
  const line = (name: string, r: { rules?: number; coverageRate: number; overblockRate: number }, cost?: string) =>
    console.log(`${name.padEnd(22)} rules ${String(r.rules ?? "-").padStart(3)} | coverage ${(100 * r.coverageRate).toFixed(1).padStart(5)}% | over-block ${(100 * r.overblockRate).toFixed(1).padStart(5)}%${cost === undefined ? "" : ` | ${cost}`}`);

  const two = evaluateRules(mineRules(events, DEFAULT_MINER), events);
  const count = evaluateRules(mineRules(events, { ...DEFAULT_MINER, approvalVeto: false }), events);
  line("miner: two-signal", two);
  line("miner: count-only", count);

  const pol = await llmPolicyRules({ port, model, events });
  line("baseline: llm-policy", evaluateRules(pol.rules, events), `tokens ${pol.usage.promptTokens}/${pol.usage.completionTokens}`);
  const jud = await llmJudge({ port, model, events });
  const je = evaluateJudge(jud.decisions, events);
  line("baseline: llm-judge", { coverageRate: je.coverageRate, overblockRate: je.overblockRate }, `judged ${je.judged}/${je.shapes}, tokens ${jud.usage.promptTokens}/${jud.usage.completionTokens}`);
}
