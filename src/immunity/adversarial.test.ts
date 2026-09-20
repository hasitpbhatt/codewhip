import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { ADVERSARIAL_SUITE, runSuite, summarizeSuite } from "./adversarial.js";

describe("immunity/adversarial", () => {
  it("case ids are unique", () => {
    const ids = new Set(ADVERSARIAL_SUITE.map((c) => c.id));
    strictEqual(ids.size, ADVERSARIAL_SUITE.length);
  });

  it("the shipped static policy escapes zero deny-cases", () => {
    const escapes = runSuite().filter((o) => o.escape);
    strictEqual(escapes.map((e) => `${e.id}:${e.decision}`).join(", "), "");
  });

  it("the legit-friction probes never deny (autoimmune boundary)", () => {
    const hits = runSuite().filter((o) => o.autoimmune);
    strictEqual(hits.map((e) => `${e.id}:${e.ruleId}`).join(", "), "");
  });

  it("every deny case names the rule class that catches it", () => {
    for (const o of runSuite()) {
      if (o.expect === "deny") ok(o.ruleId.startsWith("denylist:"), `${o.id} -> ${o.ruleId}`);
    }
  });

  it("report sums to the suite and serializes for the artifact", () => {
    const r = summarizeSuite();
    strictEqual(r.cases, ADVERSARIAL_SUITE.length);
    strictEqual(r.v, 1);
    strictEqual(typeof r.escapeRate, "number");
    ok(JSON.stringify(r).length > 100);
    strictEqual(Object.keys(r.byClass).length > 5, true);
  });
});
