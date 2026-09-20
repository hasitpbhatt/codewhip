import { summarizeSuite } from "./adversarial.js";
import { readLabeledEvents } from "./samples.js";
import { DEFAULT_MINER, evaluateRules, mineRules, sampleComplexity, type CurvePoint } from "./miner.js";
import { simulateCorpus } from "./simuser.js";

/**
 * Escape-suite runner: `npm run immunity [--escape]` prints the policy's
 * escape vs autoimmune rates — the C3 baseline measurement any induced
 * rule set is later compared against.
 *
 * `npm run immunity -- --mine [cwd]` mines the two-signal rule set from that
 * repo's outcomes.jsonl and prints the declines-to-coverage curve (add
 * `--count-only` for the one-signal ablation arm, `--json` for the artifact).
 *
 * `npm run immunity -- --sim [runs] [--seed N]` runs both arms on a seeded
 * synthetic corpus (Figure 1 skeleton) and checks the falsifiable claim:
 * two-signal buys coverage at zero autoimmune cost; count-only cannot.
 * Core-only by design (no provider, no CLI deps): the experiment must run
 * identically on a laptop and CI.
 */
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const mineMode = argv.includes("--mine");
const simMode = argv.includes("--sim");

const MARKS = [0, 0.25, 0.5, 0.75, 1];
function printCurve(curve: CurvePoint[]): void {
  for (const f of MARKS) {
    const p = curve[Math.min(curve.length - 1, Math.floor(f * (curve.length - 1)))] ?? null;
    if (p === null) continue;
    console.log(`    ${String((100 * f).toFixed(0)).padStart(3)}% of stream | declines seen ${String(p.declinesSeen).padStart(3)} | rules ${String(p.rulesMined).padStart(2)} | coverage ${(100 * p.coverageRate).toFixed(1).padStart(5)}% | over-block ${(100 * p.overblockRate).toFixed(1).padStart(5)}%`);
  }
}

if (simMode) {
  const seedIdx = argv.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) || 7 : 7;
  const afterSim = Number(argv[argv.indexOf("--sim") + 1] ?? "");
  const runs = Number.isFinite(afterSim) && afterSim > 0 ? afterSim : 300;
  const events = simulateCorpus({ seed, runs });
  const arms: { name: string; curve: CurvePoint[] }[] = [];
  for (const [name, opts] of [
    ["two-signal", DEFAULT_MINER],
    ["count-only", { ...DEFAULT_MINER, approvalVeto: false }],
  ] as const) {
    const curve = sampleComplexity(events, opts);
    const last = curve[curve.length - 1];
    arms.push({ name, curve });
    console.log(`${name} | seed ${seed} | ${runs} runs | ${events.length} labeled events | final: ${last.rulesMined} rules, coverage ${(100 * last.coverageRate).toFixed(1)}%, over-block ${(100 * last.overblockRate).toFixed(1)}%`);
    printCurve(curve);
  }
  const two = arms[0].curve[arms[0].curve.length - 1];
  const count = arms[1].curve[arms[1].curve.length - 1];
  const countCurve = arms[1].curve;
  const reach = countCurve.findIndex((p) => p.coverageRate >= two.coverageRate - 1e-9);
  const obAtParity = reach >= 0 ? countCurve[reach].overblockRate : 0;
  // Falsifiable claim: two-signal buys high coverage at a small fraction of
  // count-only's autoimmune cost, and count-only only reaches that coverage
  // by paying measurable over-block (its residual is the misclicks the
  // verdict-aware veto correctly refuses to learn from).
  const pass = two.coverageRate >= 0.8 && count.overblockRate >= 10 * two.overblockRate && obAtParity > 0;
  if (json) {
    console.log(JSON.stringify({ seed, runs, events: events.length, arms, check: { coverage: two.coverageRate, overblockTwo: two.overblockRate, overblockCount: count.overblockRate, overblockCountAtParity: obAtParity, pass } }));
  } else {
    console.log(
      `claim: two-signal coverage ${(100 * two.coverageRate).toFixed(1)}% at ${(100 * two.overblockRate).toFixed(1)}% over-block` +
        ` (vs count-only ${(100 * count.overblockRate).toFixed(1)}%); count-only pays ${(100 * obAtParity).toFixed(1)}% over-block to reach that coverage` +
        ` -> ${pass ? "PASS" : "FAIL"}`
    );
    process.exitCode = pass ? 0 : 1;
  }
} else if (!mineMode) {
  const report = summarizeSuite();
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(
      `policy ${report.policyVersion} | ${report.cases} cases (${report.denyExpected} deny-expected)` +
        ` | escapes ${report.escapes} (${(100 * report.escapeRate).toFixed(1)}%)` +
        ` | autoimmune ${report.autoimmunes} (${(100 * report.autoimmuneRate).toFixed(1)}%)`
    );
    for (const [cls, v] of Object.entries(report.byClass)) {
      console.log(`  ${cls.padEnd(18)} ${String(v.cases).padStart(2)} cases | escapes ${v.escapes} | autoimmune ${v.autoimmunes}`);
    }
    const bad = report.outcomes.filter((o) => o.escape || o.autoimmune);
    for (const o of bad) console.log(`  MISS ${o.id}: ${JSON.stringify(o.subject)} -> ${o.decision} (${o.ruleId})`);
    process.exitCode = bad.length > 0 ? 1 : 0;
  }
} else {
  const cwd = argv.find((a) => !a.startsWith("--")) ?? process.cwd();
  const events = readLabeledEvents(cwd);
  const opts = { ...DEFAULT_MINER, approvalVeto: !argv.includes("--count-only") };
  const rules = mineRules(events, opts);
  const scored = evaluateRules(rules, events);
  const curve = sampleComplexity(events, opts);
  if (json) {
    console.log(JSON.stringify({ cwd, mode: opts.approvalVeto ? "two-signal" : "count-only", events: events.length, rules, scored, curve }));
  } else {
    console.log(
      `mode ${opts.approvalVeto ? "two-signal" : "count-only"} | ${events.length} labeled events in ${cwd}` +
        ` | ${rules.length} rules | coverage ${(100 * scored.coverageRate).toFixed(1)}% of declines` +
        ` | over-block ${(100 * scored.overblockRate).toFixed(1)}% of approvals`
    );
    for (const r of rules) {
      console.log(`  deny ${r.tool}:${r.id.slice(`induced:${r.tool}:`.length)}  # ${r.provenance.declines} declined-runs, ${r.provenance.approvals} approvals seen`);
    }
    console.log("  declines-to-coverage curve:");
    printCurve(curve);
  }
}
