import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import {
  predicateToShape,
  ruleSetMatcher,
  ruleWouldOverBlock,
  shapeToPredicate,
  type InducedRule,
} from "./rules.js";

const rule = (tool: string, shape: string, over?: Partial<InducedRule>): InducedRule => ({
  id: "r-" + tool + "-" + shape,
  tool,
  predicate: shapeToPredicate(tool, shape),
  effect: "deny",
  provenance: { declines: 3, approvals: 0, runs: 2, source: "test" },
  ...over,
});

describe("immunity/rules", () => {
  it("bash head shapes round-trip through the prefix predicate", () => {
    const p = shapeToPredicate("bash", "npm publish *");
    strictEqual(p.kind, "prefix");
    strictEqual(predicateToShape(p), "npm publish *");
  });
  it("paths and origins are exact; interior stars are globs", () => {
    strictEqual(shapeToPredicate("edit", "src/a.ts").kind, "exact");
    strictEqual(shapeToPredicate("webfetch", "https://x.test").kind, "exact");
    strictEqual(shapeToPredicate("read", ".env.*").kind, "glob");
  });

  it("matcher semantics equal the production promoted-deny path", () => {
    const m = ruleSetMatcher([rule("bash", "curl *"), rule("edit", "src/gen.ts")]);
    ok(m.matches("bash", "curl"));
    ok(m.matches("bash", "curl -sS https://x"));
    strictEqual(m.matches("bash", "curlx"), false);
    ok(m.matches("edit", "src/gen.ts"));
    strictEqual(m.matches("edit", "src/gen.ts.bak"), false);
  });
  it("webfetch origin matching rejects sibling hosts", () => {
    const m = ruleSetMatcher([rule("webfetch", "https://docs.example.com")]);
    ok(m.matches("webfetch", "https://docs.example.com/guide?a=1"));
    strictEqual(m.matches("webfetch", "https://docs.example.com.evil.test/x"), false);
  });
  it("glob rules match interior wildcards", () => {
    const m = ruleSetMatcher([rule("edit", "src/generated/*.ts")]);
    ok(m.matches("edit", "src/generated/a.ts"));
    strictEqual(m.matches("edit", "src/generated/a.js"), false);
  });
  it("empty rule set matches nothing", () => {
    strictEqual(ruleSetMatcher([]).matches("bash", "anything"), false);
  });

  it("over-block guard refuses rules covering an approved shape", () => {
    const approvals = [{ tool: "bash", shape: "git push origin *" }];
    strictEqual(ruleWouldOverBlock(rule("bash", "git push origin *"), approvals), true);
    strictEqual(ruleWouldOverBlock(rule("bash", "curl *"), approvals), false);
  });
});
