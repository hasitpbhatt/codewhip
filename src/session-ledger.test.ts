import { describe, it } from "node:test";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LoopMsg } from "./provider-port.js";
import type { UsageBucket } from "./outcomes.js";
import { DEFAULT_COMPACT_TOKENS } from "./compact.js";
import { replSessionCommand, type ReplState } from "./index.js";
import {
  contextGrid,
  costLines,
  EMPTY_LEDGER,
  historyTokens,
  mergeUsage,
  usageLines,
  withShape,
  type Shape,
} from "./session-ledger.js";

/**
 * The session ledger behind `.context`, `.usage` and `.cost`
 * (docs/moat/20-parity-matrix.md row 99). Two properties carry it:
 * the numbers are summed per provider:model rather than averaged, and every
 * figure that is not a meter reading says so. The tests below therefore assert
 * on wording as much as on arithmetic — a grid that reads like a receipt while
 * being an estimate is the failure this module exists to prevent.
 */

const b = (label: string, model: string, prompt: number, completion: number, estimated?: boolean): UsageBucket =>
  ({ label, model, prompt, completion, ...(estimated === undefined ? {} : { estimated }) });

const rowOf = (lines: string[], label: string): string[] => lines.filter((l) => l.includes(label));
/** The numbers a grid row prints, left to right (thousands separators allowed). */
const nums = (line: string | undefined): number[] => (line?.match(/[\d,]+(?=\s|$)/g) ?? []).map((s) => Number(s.replace(/,/g, "")));

describe("mergeUsage", () => {
  it("sums per provider:model and counts every run", () => {
    const one = mergeUsage(EMPTY_LEDGER, [b("nvidia", "kimi", 100, 20)]);
    const two = mergeUsage(one, [b("nvidia", "kimi", 50, 5), b("groq", "gpt-oss", 10, 1)]);
    strictEqual(two.runs, 2);
    deepStrictEqual(
      two.spend.map((x) => `${x.label}:${x.model} ${x.prompt}+${x.completion}`),
      ["groq:gpt-oss 10+1", "nvidia:kimi 150+25"],
    );
  });

  it("keeps the estimated flag once any leg of a route was chars/4", () => {
    const a = mergeUsage(EMPTY_LEDGER, [b("kilo", "north", 40, 8, true)]);
    const later = mergeUsage(a, [b("kilo", "north", 60, 12)]);
    strictEqual(later.spend[0]?.estimated, true, "a metered leg does not un-estimate an estimated total");
  });

  it("never mutates the ledger it was given", () => {
    const before = mergeUsage(EMPTY_LEDGER, [b("nvidia", "kimi", 10, 1)]);
    mergeUsage(before, [b("nvidia", "kimi", 999, 999)]);
    strictEqual(before.spend[0]?.prompt, 10, "the fold returned a new total, it did not move this one");
    strictEqual(before.runs, 1);
  });

  it("counts a run that reported no usage as a run", () => {
    const folded = mergeUsage(EMPTY_LEDGER, []);
    strictEqual(folded.runs, 1);
    strictEqual(folded.spend.length, 0);
    ok(usageLines(folded)[0]?.includes("no usage rows"), usageLines(folded).join(" | "));
  });
});

describe("contextGrid", () => {
  const shape = (over: Partial<Shape> = {}): Shape =>
    ({ system: 1000, tools: 500, ceiling: DEFAULT_COMPACT_TOKENS, ...over });

  const history: LoopMsg[] = [
    { role: "user", content: "fix the flaky test" },
    { role: "assistant", content: "reading it", toolCalls: [{ id: "t1", name: "read", argsJson: "{\"path\":\"src/a.ts\"}" }] },
    { role: "tool", content: "it asserts on Date.now()", toolCallId: "t1" },
    { role: "assistant", content: "pinned the clock" },
  ];

  it("adds the two fixed costs and the transcript to get used", () => {
    const s = shape();
    const lines = contextGrid({ provider: "nvidia", model: "kimi", shape: s, history });
    const hist = historyTokens(history);
    const used = nums(rowOf(lines, "used")[0])[0];
    const num = (n: number): string => n.toLocaleString("en-US");
    strictEqual(lines[0], ".context — est. tokens (chars/4; the same measure compaction budgets with), provider nvidia:kimi");
    ok(rowOf(lines, "system prompt")[0]?.includes(num(s.system)), lines.join("\n"));
    ok(rowOf(lines, "tool specs")[0]?.includes(num(s.tools)), lines.join("\n"));
    ok(rowOf(lines, "history")[0]?.includes(num(hist)), lines.join("\n"));
    strictEqual(used, s.system + s.tools + hist);
    ok(rowOf(lines, "free")[0]?.includes(num(s.ceiling - used)), lines.join("\n"));
    ok(lines.some((l) => l.includes(`ceiling ${num(s.ceiling)} is the compaction limit`)), lines.join("\n"));
  });

  it("breaks the transcript down by role and counts the tool calls in it", () => {
    const lines = contextGrid({ provider: "nvidia", model: "kimi", shape: shape(), history });
    const body = lines.join("\n");
    for (const role of ["user", "assistant", "tool"]) {
      const expected = historyTokens(history.filter((m) => m.role === role));
      ok(rowOf(lines, `· ${role}`)[0]?.includes(expected.toLocaleString("en-US")), `${role} ${body}`);
    }
    ok(body.replace(/\s+/g, " ").includes("· tool calls 1 (asked for by 1 assistant turn)"), body);
  });

  it("says there is no shape yet instead of drawing a grid of zeroes", () => {
    const lines = contextGrid({ provider: "nvidia", model: "kimi", history: [] });
    ok(lines.some((l) => l.includes("no run yet this session")), lines.join("\n"));
    strictEqual(lines.some((l) => l.includes("ceiling")), false, "a ceiling of 0 is not a limit");
    strictEqual(nums(rowOf(lines, "used")[0])[0], 0);
  });

  it("says so when the transcript is over the compaction limit", () => {
    const lines = contextGrid({ provider: "nvidia", model: "kimi", shape: shape({ ceiling: 100 }), history });
    ok(lines.some((l) => l.includes("OVER")), lines.join("\n"));
    strictEqual(nums(rowOf(lines, "free")[0])[0], 0, "free is clamped at zero, never negative");
  });
});

describe("usageLines", () => {
  it("prints nothing-metered honestly for a fresh session", () => {
    ok(usageLines(EMPTY_LEDGER)[0]?.includes("nothing metered yet"), usageLines(EMPTY_LEDGER).join(" | "));
  });

  it("totals across routes and marks the estimate only when one leg was estimated", () => {
    const clean = mergeUsage(EMPTY_LEDGER, [b("nvidia", "kimi", 1000, 200)]);
    ok(usageLines(clean).join("\n").includes("1,200 tokens"), usageLines(clean).join(" | "));
    strictEqual(usageLines(clean).some((l) => l.includes("(est.)")), false);
    const est = mergeUsage(clean, [b("kilo", "north", 400, 80, true)]);
    const body = usageLines(est).join("\n");
    ok(body.includes("(est.)"), body);
    ok(body.includes("chars/4, not meter readings"), body);
    ok(body.includes("1,400 prompt + 280 completion = 1,680 tokens"), body);
  });
});

describe("costLines", () => {
  it("prints a total for a priced route, with the reason it is what it is", () => {
    const free = mergeUsage(EMPTY_LEDGER, [b("nvidia", "moonshotai/kimi-k3", 1000, 200)]);
    const body = costLines(free).join("\n");
    ok(body.includes("$0.0000"), body);
    ok(body.includes("nvidia free tier"), body);
    strictEqual(body.includes("untracked"), false, body);
  });

  it("refuses a total when one leg has no price row, and never calls it $0.00", () => {
    const mixed = mergeUsage(EMPTY_LEDGER, [b("nvidia", "moonshotai/kimi-k3", 1000, 200), b("acme", "acme-1", 10, 1)]);
    const lines = costLines(mixed);
    const body = lines.join("\n");
    ok(body.includes("no session total"), body);
    ok(body.includes("acme:acme-1"), body);
    strictEqual(lines.some((l) => l.includes("$0.00")), false, `an unpriced leg must not buy a $0 total:\n${body}`);
    strictEqual(costLines(mergeUsage(EMPTY_LEDGER, [])).length, 1);
    ok(costLines(EMPTY_LEDGER)[0]?.includes("run a prompt first"));
  });
});

const state = (over: Partial<ReplState> = {}): ReplState => ({
  history: [],
  provider: "nvidia",
  model: "moonshotai/kimi-k3",
  lastRunId: null,
  sessionId: null,
  labels: { tags: [] },
  ledger: EMPTY_LEDGER,
  ...over,
});

describe("the three REPL verbs", () => {
  const cwd = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-ledger-"));
  const say = (line: string, s: ReplState): string[] => {
    const out = replSessionCommand(cwd(), s, line);
    ok(out !== null, `${line} should be a session command`);
    return out;
  };

  it("are recognised in both dot and slash form and take no argument", () => {
    for (const verb of ["context", "usage", "cost"]) {
      for (const prefix of [".", "/"]) {
        const lines = say(`${prefix}${verb}`, state());
        strictEqual(lines.length > 0, true, `${prefix}${verb} printed nothing`);
        ok(say(`${prefix}${verb} extra`, state()).some((l) => l.includes("takes no argument")), `${prefix}${verb} arg`);
      }
    }
  });

  it("read the ledger the last runs folded in, not a fresh guess", () => {
    const run1 = mergeUsage(EMPTY_LEDGER, [b("nvidia", "moonshotai/kimi-k3", 1200, 240)]);
    const run2 = withShape(mergeUsage(run1, [b("nvidia", "moonshotai/kimi-k3", 800, 60)]), {
      system: 900,
      tools: 700,
      ceiling: DEFAULT_COMPACT_TOKENS,
    });
    const s = state({ ledger: run2, history: [{ role: "user", content: "again" }], lastRunId: "r2" });
    const usage = say(".usage", s).join("\n");
    ok(usage.includes("2 runs this session"), usage);
    ok(usage.includes("2,000 prompt + 300 completion"), usage);
    const cost = say(".cost", s).join("\n");
    ok(cost.includes("2 runs this session: $0.0000"), cost);
    const ctx = say(".context", s).join("\n");
    ok(/system prompt\s+900/.test(ctx), ctx);
    ok(/tool specs\s+700/.test(ctx), ctx);
    ok(/history\s+\d/.test(ctx), ctx);
    ok(ctx.includes(String(DEFAULT_COMPACT_TOKENS.toLocaleString("en-US"))), ctx);
  });

  it("stay read-only — no verb here writes a session file", () => {
    const dir = cwd();
    const s = state({ sessionId: "aaaaaaaa-0000-4000-8000-000000000001" });
    for (const line of [".context", ".usage", ".cost"]) say(line, s);
    strictEqual(fs.existsSync(path.join(dir, ".codewhip")), false, "the ledger lives in memory until .exit");
  });
});
