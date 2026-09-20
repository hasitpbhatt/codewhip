import { matchesPromoted, type PromotedDeny } from "../policy-store.js";

/**
 * Induced-rule AST — the language the two-signal miner emits and the
 * experiment harness evaluates. Enforcement compatibility is the contract:
 * every rule compiles to a `deny <tool>:<shape>` line that `matchesPromoted`
 * (the production matcher) understands byte-for-byte, so a learned rule can
 * never mean more at experiment time than it will mean in the harness.
 */
export type RulePredicate =
  | { kind: "exact"; value: string }
  /** bash head form: bare head or head + args ("git push"). */
  | { kind: "prefix"; value: string }
  /** one interior `*` ("*.env", "src/generated/*.ts"). */
  | { kind: "glob"; value: string };

export type RuleProvenance = {
  declines: number;
  approvals: number;
  runs: number;
  /** Which induction produced it — free-form tag for ablation bookkeeping. */
  source: string;
};

export type InducedRule = {
  id: string;
  tool: string;
  predicate: RulePredicate;
  effect: "deny";
  provenance: RuleProvenance;
};

/** Compile a decline/approval shape (declineShape vocabulary) into a predicate. */
export function shapeToPredicate(tool: string, shape: string): RulePredicate {
  if (tool === "bash" && shape.endsWith(" *")) {
    return { kind: "prefix", value: shape.slice(0, -2).trimEnd() };
  }
  if (shape.includes("*")) return { kind: "glob", value: shape };
  return { kind: "exact", value: shape };
}

/** Compile a predicate back to the stored-shape grammar matchesPromoted speaks. */
export function predicateToShape(predicate: RulePredicate): string {
  switch (predicate.kind) {
    case "exact":
      return predicate.value;
    case "prefix":
      return `${predicate.value} *`;
    case "glob":
      return predicate.value;
  }
}

export interface DenyLike {
  /** Same semantics as checkPermission's promoted-deny probe. */
  matches(tool: string, subject: string): boolean;
}

/** Bind rules to the production matcher. Empty set matches nothing. */
export function ruleSetMatcher(rules: InducedRule[]): DenyLike {
  const denies: PromotedDeny[] = rules.map((r, i) => ({
    tool: r.tool,
    shape: predicateToShape(r.predicate),
    line: i + 1,
  }));
  return {
    matches(tool: string, subject: string): boolean {
      return matchesPromoted(tool, subject, denies) !== null;
    },
  };
}

/**
 * Over-block guard used before any induced rule ships: replay the positive
 * samples through the matcher and refuse a rule that a settled approval
 * *habit* (≥ minRuns distinct runs) says would over-block. A one-off
 * approval below the habit bar does not veto — misclick noise must not
 * permanently disarms a rule the verdict stream keeps vindicating.
 */
export function ruleWouldOverBlock(
  rule: InducedRule,
  approvals: { tool: string; shape: string; runId?: string }[],
  minRuns = 1
): boolean {
  const m = ruleSetMatcher([rule]);
  const runs = new Set<string>();
  for (const a of approvals) {
    if (!m.matches(a.tool, a.shape)) continue;
    runs.add(a.runId ?? `${a.tool}:${a.shape}`);
    if (runs.size >= minRuns) return true;
  }
  return false;
}
