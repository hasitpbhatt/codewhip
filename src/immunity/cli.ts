import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { summarizeSuite } from "./adversarial.js";
import { readLabeledEvents, splitEvents } from "./samples.js";
import type { PromotedDeny } from "../policy-store.js";
import { predicateToShape } from "./rules.js";
import { DEFAULT_MINER, evaluateRules, mineRules, sampleComplexity, type CurvePoint, type MinerOptions } from "./miner.js";
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
 * two-signal buys coverage at a near-zero autoimmune residual; count-only cannot.
 * `--seeds N` replaces the curves with the robustness table over seeds
 * 1..N: both arms, the no-verdict-weights ablation, and train→held-out
 * generalization per seed (pass = claim holds for every seed).
 *
 * `npm run immunity -- --replay [runs] [--seed N]` stacks the miner's
 * induced rule set (from a sim corpus of the same shape language) on top
 * of the static policy and re-runs the 67-case suite: escapes and
 * autoimmune must both stay 0 (claim P3 in docs/moat/18).
 *
 * `npm run immunity -- --export <out.jsonl> [cwd...]` writes the D&B corpus
 * artifact: labeled events only (no raw args, no commands), repos
 * pseudonymized under a fresh per-invocation salt. Re-run per consented
 * repo set; the salt keeps cross-export linkage impossible.
 * Core-only by design (no provider, no CLI deps): the experiment must run
 * identically on a laptop and CI.
 */
const argv = process.argv.slice(2);
const json = argv.includes("--json");
const mineMode = argv.includes("--mine");
const simMode = argv.includes("--sim");
const replayMode = argv.includes("--replay");
const exportIdx = argv.indexOf("--export");

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
  const seedsIdx = argv.indexOf("--seeds");
  if (seedsIdx >= 0) {
    // Robustness table: the claim must hold on every seed. The
    // no-verdict ablation (flat weights + verdict-blind veto) is reported
    // per-seed: its coverage column is the variance, the two-signal
    // column is the floor — verdict-awareness buys stability against
    // regret-approval poisoning, at the price of slower early learning.
    const n = Number(argv[seedsIdx + 1]) || 5;
    const COUNT_ONLY: MinerOptions = { ...DEFAULT_MINER, approvalVeto: false };
    const NO_VERDICT: MinerOptions = {
      ...DEFAULT_MINER,
      verdictAwareVeto: false,
      verdictWeights: { reverted: 1, rejected: 1, accepted: 1, edited: 1 },
    };
    const pct = (x: number) => (100 * x).toFixed(1).padStart(5);
    /** First declinesSeen at which the arm's full-stream coverage hits 80%. */
    const declinesTo80 = (curve: CurvePoint[]) => {
      const p = curve.find((c) => c.coverageRate >= 0.8);
      return p === undefined ? Number.POSITIVE_INFINITY : p.declinesSeen;
    };
    console.log("seed | two-sig cov/ob  | no-verdict cov/ob | count-only cov/ob | heldout cov/ob | declines→80%: two vs no-verdict");
    let allPass = true;
    const rows: unknown[] = [];
    for (let s = 1; s <= n; s++) {
      const ev = simulateCorpus({ seed: s, runs });
      const two = evaluateRules(mineRules(ev, DEFAULT_MINER), ev);
      const nvCurve = sampleComplexity(ev, NO_VERDICT);
      const nv = evaluateRules(mineRules(ev, NO_VERDICT), ev);
      const co = evaluateRules(mineRules(ev, COUNT_ONLY), ev);
      const { train, heldOut } = splitEvents(ev, 0.7);
      const held = evaluateRules(mineRules(train, DEFAULT_MINER), heldOut);
      const d2 = declinesTo80(sampleComplexity(ev, DEFAULT_MINER));
      const dNv = declinesTo80(nvCurve);
      // Honest claim set from the sweep: verdict-awareness (a) can never
      // cost end coverage (a verdict-blind veto is poisoned whenever the
      // regret approvals it ignores cross the habit bar — the no-verdict
      // column is the one that varies) and (b) trades early speed for that
      // robustness: discounted accepted-run declines slow induction, so
      // declines→80% is reported, not required.
      const pass =
        two.coverageRate >= 0.8 && two.overblockRate <= 0.05 &&
        co.overblockRate >= 10 * Math.max(two.overblockRate, 0.001) &&
        held.coverageRate >= 0.75 && held.overblockRate <= 0.05 &&
        two.coverageRate >= nv.coverageRate - 1e-9;
      allPass &&= pass;
      rows.push({ seed: s, two, nv, co, held, declinesTo80Two: d2, declinesTo80NoVerdict: dNv, pass });
      console.log(
        `${String(s).padStart(4)} | ${pct(two.coverageRate)}/${pct(two.overblockRate)}  | ${pct(nv.coverageRate)}/${pct(nv.overblockRate)}  | ${pct(co.coverageRate)}/${pct(co.overblockRate)}  | ${pct(held.coverageRate)}/${pct(held.overblockRate)} | ${String(d2).padStart(3)} vs ${String(dNv).padStart(3)} ${pass ? "ok" : "FAIL"}`
      );
    }
    console.log(allPass ? `robustness: claim holds on all ${n} seeds -> PASS` : `robustness: a seed breaks the claim -> FAIL (investigate)`);
    if (json) console.log(JSON.stringify({ mode: "seeds", runs, rows }));
    process.exitCode = allPass ? 0 : 1;
  } else {
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
  }
} else if (replayMode) {
  const afterReplay = Number(argv[argv.indexOf("--replay") + 1] ?? "");
  const runs = Number.isFinite(afterReplay) && afterReplay > 0 ? afterReplay : 300;
  const seedIdx = argv.indexOf("--seed");
  const seed = seedIdx >= 0 ? Number(argv[seedIdx + 1]) || 7 : 7;
  const events = simulateCorpus({ seed, runs });
  const rules = mineRules(events, DEFAULT_MINER);
  const denies: PromotedDeny[] = rules.map((r, i) => ({
    tool: r.tool,
    shape: predicateToShape(r.predicate),
    line: i + 1,
  }));
  const report = summarizeSuite(denies);
  console.log(`induced replay | seed ${seed} | ${rules.length} stacked rules | escapes ${report.escapes} | autoimmune ${report.autoimmunes}`);
  for (const o of report.outcomes.filter((x) => x.escape || x.autoimmune)) {
    console.log(`  MISS ${o.id}: ${JSON.stringify(o.subject)} -> ${o.decision} (${o.ruleId})`);
  }
  const pass = report.escapes === 0 && report.autoimmunes === 0;
  console.log(`P3: induced set is safe to stack on the static policy -> ${pass ? "PASS" : "FAIL"}`);
  process.exitCode = pass ? 0 : 1;
} else if (exportIdx >= 0) {
  const outPath = argv[exportIdx + 1];
  if (outPath === undefined || outPath.startsWith("--")) {
    console.error("usage: immunity --export <out.jsonl> [cwd...]");
    process.exitCode = 1;
  } else {
    const salt = randomUUID();
    const cwds = argv.slice(exportIdx + 2).filter((a) => !a.startsWith("--"));
    const lines: string[] = [];
    const repos: { id: string; events: number }[] = [];
    let declines = 0;
    let approvals = 0;
    const verdicts = new Map<string, number>();
    for (const repoCwd of cwds.length > 0 ? cwds : [process.cwd()]) {
      const id = createHash("sha256").update(`${salt}\u0000${repoCwd}`).digest("hex").slice(0, 16);
      const evs = readLabeledEvents(repoCwd);
      for (const e of evs) {
        if (e.label === "decline") declines += 1;
        else approvals += 1;
        const vk = e.verdict ?? "null";
        verdicts.set(vk, (verdicts.get(vk) ?? 0) + 1);
        lines.push(JSON.stringify({
          v: 1, kind: "event", repo: id, ts: e.ts, run_id: e.runId, tool: e.tool,
          shape: e.shape, label: e.label, rule_id: e.ruleId, verdict: e.verdict,
          ...(e.taskClass === undefined ? {} : { task_class: e.taskClass }),
        }));
      }
      repos.push({ id, events: evs.length });
    }
    lines.unshift(JSON.stringify({
      v: 1, kind: "meta", exported: new Date().toISOString(), repos,
      events: declines + approvals,
      label_counts: { declines, approvals },
      verdict_counts: Object.fromEntries(verdicts),
      note: "labeled permission events only — no commands, args, or file contents. Repo pseudonyms are comparable within this file only (fresh random salt per export). Shapes may reveal repo-relative paths: publish only with per-repo consent.",
    }));
    fs.writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
    console.log(`exported ${declines + approvals} labeled events (${declines} declines / ${approvals} approvals) from ${repos.length} repo(s) -> ${outPath}`);
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
