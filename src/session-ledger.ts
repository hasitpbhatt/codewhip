import type { LoopMsg } from "./provider-port.js";
import { estimateTokens } from "./compact.js";
import { costNote, estimateCost, meteredCost } from "./router.js";
import type { UsageBucket } from "./outcomes.js";

/**
 * The session ledger behind `.context`, `.usage` and `.cost`.
 *
 * A REPL run is a sequence of loops, and until now each one printed its own
 * receipt while the session kept nothing: there was no answer to "what has this
 * conversation cost me" or "how full is my context". Both questions are asked
 * mid-run, at a keyboard, which is why the answers are plain lines rather than
 * a JSON document.
 *
 * The one rule the whole module follows is that an estimate is labelled an
 * estimate. Every token number here is chars/4 (what the compactor budgets
 * with), the ceiling is the compaction limit the run actually used — which is
 * derived from the model's window only where a provider row declares one — and a
 * leg whose price is unknown stops the dollar total from being printed at all.
 * A grid that looked precise while being wrong would be worse than no grid: it
 * is exactly the kind of number a person trusts and then runs out of context on.
 */

export type Shape = { system: number; tools: number; ceiling: number };

export type Ledger = {
  spend: UsageBucket[];
  runs: number;
  shape?: Shape;
};

export const EMPTY_LEDGER: Ledger = { spend: [], runs: 0 };

/** Add one run's usage to the session total, merged per provider:model. */
export function mergeUsage(ledger: Ledger, rows: readonly UsageBucket[]): Ledger {
  const byKey = new Map<string, UsageBucket>(ledger.spend.map((b) => [`${b.label}:${b.model}`, { ...b }]));
  for (const row of rows) {
    const key = `${row.label}:${row.model}`;
    const seen = byKey.get(key);
    if (seen === undefined) {
      byKey.set(key, { ...row });
      continue;
    }
    seen.prompt += row.prompt;
    seen.completion += row.completion;
    // Once any leg of this route has been counted by chars/4 instead of read
    // off a usage block, the whole running total is that kind of number.
    if (row.estimated === true) seen.estimated = true;
  }
  return {
    spend: [...byKey.values()].sort((a, b) => `${a.label}:${a.model}`.localeCompare(`${b.label}:${b.model}`)),
    runs: ledger.runs + 1,
    ...(ledger.shape === undefined ? {} : { shape: ledger.shape }),
  };
}

/** Record what the last run put on the wire, as the loop itself reported it. */
export function withShape(ledger: Ledger, shape: Shape): Ledger {
  return { ...ledger, shape };
}

function num(n: number): string {
  return n.toLocaleString("en-US");
}

function pct(part: number, whole: number): string {
  return `${((part / whole) * 100).toFixed(1)}%`;
}

/** A breakdown line under `history` — same column as the grid's own rows. */
function bullet(label: string, n: number): string {
  return `    · ${label.padEnd(11)}${num(n)}`;
}

/** Tokens one message list occupies — the same measure the compactor uses. */
export function historyTokens(messages: readonly LoopMsg[]): number {
  return estimateTokens([...messages]);
}

/**
 * The context grid: the two fixed costs a run pays before the model answers,
 * then the transcript by role, then what is left of the ceiling. The fixed
 * costs come from the loop's own report — recomputing them here would build a
 * second guess of the prompt and call the difference the truth.
 */
export function contextGrid(opts: {
  provider: string;
  model: string;
  shape?: Shape;
  history: readonly LoopMsg[];
}): string[] {
  const shape: Shape = opts.shape ?? { system: 0, tools: 0, ceiling: 0 };
  // Summed over the whole list, exactly as the compactor measures it — the
  // per-role figures below are breakdowns and may round differently.
  const hist = historyTokens(opts.history);
  const byRole = new Map<string, number>();
  for (const m of opts.history) {
    byRole.set(m.role, (byRole.get(m.role) ?? 0) + estimateTokens([m]));
  }
  const used = shape.system + shape.tools + hist;
  const out: string[] = [
    `.context — est. tokens (chars/4; the same measure compaction budgets with), provider ${opts.provider}:${opts.model}`,
  ];
  if (opts.shape === undefined) {
    out.push("  (no run yet this session — the system/tool figures arrive with the first one)");
  }
  const width = Math.max(num(shape.system).length, num(shape.tools).length, num(hist).length, num(used).length);
  const row = (label: string, n: number): string => `  ${label.padEnd(16)}${num(n).padStart(width)}  ${shape.ceiling > 0 ? pct(n, shape.ceiling).padStart(6) : ""}`;
  out.push(row("system prompt", shape.system));
  out.push(row("tool specs", shape.tools));
  out.push(row("history", hist));
  for (const role of ["user", "assistant", "tool"]) {
    const n = byRole.get(role);
    if (n !== undefined && n > 0) out.push(bullet(role, n));
  }
  const calls = opts.history.reduce((acc, m) => acc + (m.toolCalls?.length ?? 0), 0);
  const callTurns = opts.history.filter((m) => m.toolCalls !== undefined).length;
  if (calls > 0) out.push(bullet("tool calls", calls) + ` (asked for by ${callTurns} assistant turn${callTurns === 1 ? "" : "s"})`);
  out.push(row("used", used));
  if (shape.ceiling > 0) {
    out.push(row("free", Math.max(0, shape.ceiling - used)));
    out.push(
      `  ceiling ${num(shape.ceiling)} is the compaction limit${used > shape.ceiling ? " — OVER it, the transcript is being pruned to stay under" : ""}`
    );
  }
  return out;
}

/** Cumulative tokens by route, with the estimated flag preserved. */
export function usageLines(ledger: Ledger): string[] {
  if (ledger.spend.length === 0) {
    return [`.usage: nothing metered yet (${ledger.runs === 0 ? "no run this session" : "the runs returned no usage rows"})`];
  }
  const out = [`.usage — ${ledger.runs} run${ledger.runs === 1 ? "" : "s"} this session`];
  for (const b of ledger.spend) {
    out.push(`  ${(b.label + ":" + b.model).padEnd(34)} ${num(b.prompt).padStart(9)} prompt + ${num(b.completion).padStart(8)} completion${b.estimated === true ? "  (est.)" : ""}`);
  }
  const p = ledger.spend.reduce((a, b) => a + b.prompt, 0);
  const c = ledger.spend.reduce((a, b) => a + b.completion, 0);
  out.push(`  total: ${num(p)} prompt + ${num(c)} completion = ${num(p + c)} tokens`);
  if (ledger.spend.some((b) => b.estimated === true)) {
    out.push("  est. = the provider sent no usage block, so these are chars/4, not meter readings");
  }
  return out;
}

/**
 * Cumulative cost. Unpriced is said out loud: a session total rendered as
 * `$0.00` because one leg has no price row is the exact lie this module exists
 * to avoid.
 */
export function costLines(ledger: Ledger): string[] {
  if (ledger.spend.length === 0) {
    return [".cost: nothing metered yet — run a prompt first"];
  }
  const cost = meteredCost(ledger.spend);
  if (cost === null) {
    // One unpriced leg poisons the sum, so say which one rather than
    // printing a smaller number that looks like a total.
    const unknown = ledger.spend.filter((b) => estimateCost(b.label, b.model, b.prompt, b.completion) === null);
    const route = (b: UsageBucket): string => `${b.label}:${b.model}`;
    return [
      `.cost: no session total — ${unknown.map(route).join(", ")} ${unknown.length === 1 ? "has" : "have"} no price row`,
      ...unknown.map((b) => `  ${route(b)}: ${costNote(b.label, b.model)}`),
    ];
  }
  const notes = [...new Set(ledger.spend.map((b) => costNote(b.label, b.model)))];
  return [
    `.cost — ${ledger.runs} run${ledger.runs === 1 ? "" : "s"} this session: $${cost.toFixed(4)}`,
    `  ${notes.join(" · ")}`,
  ];
}
