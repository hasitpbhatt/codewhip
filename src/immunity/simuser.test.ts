import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { DEFAULT_MINER, evaluateRules, mineRules } from "./miner.js";
import { simulateCorpus } from "./simuser.js";
import { splitEvents } from "./samples.js";

const COUNT_ONLY = { ...DEFAULT_MINER, approvalVeto: false };

describe("immunity/simuser", () => {
  it("is deterministic: same seed yields a byte-identical stream", () => {
    const a = JSON.stringify(simulateCorpus({ seed: 7, runs: 50 }));
    strictEqual(JSON.stringify(simulateCorpus({ seed: 7, runs: 50 })), a);
    ok(JSON.stringify(simulateCorpus({ seed: 8, runs: 50 })) !== a);
  });

  it("yields both signal classes and regret-labeled runs", () => {
    const ev = simulateCorpus({ seed: 7, runs: 100 });
    ok(ev.some((x) => x.label === "decline"));
    ok(ev.some((x) => x.label === "approval"));
    ok(ev.some((x) => x.verdict === "reverted" || x.verdict === "rejected"));
  });

  it("hypothesis: two-signal buys ≥80% coverage at <1/4 count-only's autoimmune cost", () => {
    const ev = simulateCorpus({ seed: 7, runs: 300 });
    const two = evaluateRules(mineRules(ev, DEFAULT_MINER), ev);
    const count = evaluateRules(mineRules(ev, COUNT_ONLY), ev);
    ok(two.coverageRate >= 0.8, `two-signal coverage ${two.coverageRate}`);
    ok(two.rules >= 6, `expected all six danger shapes, got ${two.rules}`);
    ok(count.overblockRate >= 4 * two.overblockRate, `count-only over-block ${count.overblockRate} vs two ${two.overblockRate}`);
  });

  it("generalizes forward in time: mine on train, score on held-out", () => {
    const { train, heldOut } = splitEvents(simulateCorpus({ seed: 7, runs: 300 }), 0.7);
    const held = evaluateRules(mineRules(train, DEFAULT_MINER), heldOut);
    ok(held.coverageRate >= 0.8, `held-out coverage ${held.coverageRate}`);
    ok(held.overblockRate <= 0.05, `held-out over-block ${held.overblockRate}`);
  });
});
