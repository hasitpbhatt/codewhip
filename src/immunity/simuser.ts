import type { Verdict } from "../verdict.js";
import type { LabeledEvent } from "./samples.js";

/**
 * Seeded synthetic-corpus generator — the paper's Figure 1 skeleton.
 *
 * Real dogfood telemetry accrues one labeled bit per human answer, so the
 * miner experiments cannot wait on it. This simulates repo archetypes
 * (habitual shapes), human habits (per-shape decline probability) and
 * misclick noise (benign shapes occasionally declined; dangerous shapes
 * occasionally approved, which then correlate with reverted/rejected
 * verdicts). Deterministic: the same seed yields a byte-identical stream.
 *
 * The point of the corpus design: shapes like `docker *` / `ssh *` collect
 * BOTH declines and approvals (misclicks), so the count-only arm mines
 * them and pays autoimmune cost, while the two-signal arm's approval veto
 * refuses them at zero coverage cost on the true-danger shapes.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Habit = {
  tool: "bash" | "edit";
  shape: string;
  /** Probability the human says no when the harness asks about this shape. */
  declineRate: number;
  /** True = the human's stable answer is no; approving it is a misclick
   * that raises the odds the run ends reverted/rejected. */
  alwaysDecline?: boolean;
};
type Archetype = { id: string; habits: Habit[] };

export const ARCHETYPES: Archetype[] = [
  {
    id: "node-web",
    habits: [
      { tool: "bash", shape: "git push origin *", declineRate: 0.05 },
      { tool: "bash", shape: "pnpm test *", declineRate: 0.0 },
      { tool: "bash", shape: "docker *", declineRate: 0.15 },
      { tool: "bash", shape: "npm publish *", declineRate: 0.95, alwaysDecline: true },
      { tool: "bash", shape: "curl *", declineRate: 0.95, alwaysDecline: true },
      { tool: "edit", shape: "src/routes.ts", declineRate: 0.0 },
    ],
  },
  {
    id: "python-ml",
    habits: [
      { tool: "bash", shape: "pip install *", declineRate: 0.12 },
      { tool: "bash", shape: "git push origin *", declineRate: 0.05 },
      { tool: "bash", shape: "wget *", declineRate: 0.95, alwaysDecline: true },
      { tool: "bash", shape: "hf upload *", declineRate: 0.95, alwaysDecline: true },
      { tool: "edit", shape: "notebooks/exp.ipynb", declineRate: 0.02 },
      { tool: "edit", shape: "scripts/train.py", declineRate: 0.0 },
    ],
  },
  {
    id: "infra",
    habits: [
      { tool: "bash", shape: "terraform plan *", declineRate: 0.02 },
      { tool: "bash", shape: "kubectl get *", declineRate: 0.0 },
      { tool: "bash", shape: "ssh *", declineRate: 0.12 },
      { tool: "bash", shape: "aws s3 cp *", declineRate: 0.15 },
      { tool: "bash", shape: "terraform apply *", declineRate: 0.95, alwaysDecline: true },
      { tool: "bash", shape: "kubectl delete *", declineRate: 0.95, alwaysDecline: true },
    ],
  },
];

const VERDICT_CALM: [Verdict | null, number][] = [
  [null, 0.15], ["accepted", 0.55], ["edited", 0.15], ["reverted", 0.1], ["rejected", 0.05],
];
const VERDICT_BURNED: [Verdict | null, number][] = [
  [null, 0.1], ["accepted", 0.1], ["edited", 0.1], ["reverted", 0.45], ["rejected", 0.35],
];

function pick<T>(rnd: () => number, table: [T, number][]): T {
  let r = rnd();
  for (const [v, p] of table) {
    r -= p;
    if (r < 0) return v;
  }
  return table[table.length - 1][0];
}

export type SimOptions = { seed: number; runs: number; startTs?: string };

export function simulateCorpus(opts: SimOptions): LabeledEvent[] {
  const rnd = mulberry32(opts.seed);
  const start = Date.parse(opts.startTs ?? "2026-01-05T09:00:00Z");
  const events: LabeledEvent[] = [];
  for (let i = 0; i < opts.runs; i++) {
    const arch = ARCHETYPES[i % ARCHETYPES.length];
    const ts = new Date(start + i * 86_400_000).toISOString();
    const runId = `sim-${String(i).padStart(4, "0")}`;
    const buffer: LabeledEvent[] = [];
    let burned = false;
    const asks = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < asks; k++) {
      const h = arch.habits[Math.floor(rnd() * arch.habits.length)];
      const declined = rnd() < h.declineRate;
      if (!declined && h.alwaysDecline) burned = true;
      const base = h.tool === "bash" ? "shell" : h.tool;
      buffer.push({
        ts,
        runId,
        tool: h.tool,
        shape: h.shape,
        label: declined ? "decline" : "approval",
        ruleId: `default:${base}:ask${declined ? "+declined" : ""}`,
        verdict: null,
      });
    }
    const verdict = pick(rnd, burned ? VERDICT_BURNED : VERDICT_CALM);
    for (const e of buffer) {
      e.verdict = verdict;
      events.push(e);
    }
  }
  return events;
}
