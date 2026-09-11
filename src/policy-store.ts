import * as fs from "node:fs";
import * as path from "node:path";
import { readOutcomeRecords } from "./outcomes.js";

/**
 * Promoted policy: repeated human declines compile into pre-flight denies.
 *
 * Flow: 3+ declines of the same tool:shape (recorded in outcomes.jsonl) →
 * `codewhip policy candidates` lists them → `policy approve <tool:shape>`
 * appends a `deny` line to `<cwd>/policy.md` → the loop loads it once per
 * run and `checkPermission` denies before any token burns, with rule pointer
 * `policy.md:deny:<tool>:<shape>`.
 *
 * Safety by construction: the file only honors `deny` lines (anything else
 * is ignored), so promotion can only ever refuse — never permit. The
 * non-overridable denylist still wins over promoted lines; promoted lines
 * win over the allowlist and ask-defaults.
 */
export type PromotedDeny = {
  tool: string;
  shape: string;
  line: number;
};

export function policyMdPath(cwd: string): string {
  return path.join(cwd, "policy.md");
}

/** Parse `deny <tool>:<shape>` lines; blanks, comments, and malformed lines are ignored. */
export function loadPromotedDenies(cwd: string): PromotedDeny[] {
  try {
    const raw = fs.readFileSync(policyMdPath(cwd), "utf8");
    const out: PromotedDeny[] = [];
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const t = (lines[i] as string).trim();
      if (t.length === 0 || t.startsWith("#")) continue;
      // Trailing " # comment" is metadata (the writer stamps provenance
      // there); strip it before matching so the shape round-trips.
      const rule = t.replace(/\s+#.*$/, "");
      const m = /^deny\s+([A-Za-z0-9_-]+):(\S(?:.*\S)?)\s*$/.exec(rule);
      if (m === null) continue;
      out.push({ tool: m[1] as string, shape: (m[2] as string).trim(), line: i + 1 });
    }
    return out;
  } catch {
    return [];
  }
}

export function matchesPromoted(tool: string, subject: string, denies: PromotedDeny[]): PromotedDeny | null {
  for (const d of denies) {
    if (d.tool !== tool) continue;
    if (d.shape.endsWith("*")) {
      const head = d.shape.slice(0, -1).trimEnd();
      if (head.length > 0 && (subject === head || subject.startsWith(head + " "))) {
        return d;
      }
    } else if (subject === d.shape) {
      return d;
    }
  }
  return null;
}

/** Append one deny line (idempotent — false when already present or on disk failure). */
export function appendPromotedDeny(cwd: string, tool: string, shape: string, count: number): boolean {
  try {
    const file = policyMdPath(cwd);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(
        file,
        "# CodeWhip promoted policy — one rule per line: deny <tool>:<shape>\n" +
          "# Promoted from repeated human declines. Denies beat the allowlist;\n" +
          "# the non-overridable denylist still beats these. Only `deny` lines are honored.\n",
        "utf8"
      );
    } else if (loadPromotedDenies(cwd).some((d) => d.tool === tool && d.shape === shape)) {
      return false;
    }
    fs.appendFileSync(
      file,
      `deny ${tool}:${shape}  # promoted ${new Date().toISOString().slice(0, 10)} (${count} declines)\n`,
      "utf8"
    );
    return true;
  } catch {
    return false;
  }
}

export type PromotionCandidate = {
  tool: string;
  shape: string;
  count: number;
};

/**
 * Group declined asks by tool:shape (3+ = candidate), excluding shapes
 * already promoted. Reads outcomes.jsonl — declines without a recorded
 * shape can't generalize and are skipped.
 */
export function declineCandidates(cwd: string, threshold = 3): PromotionCandidate[] {
  const counts = new Map<string, number>();
  for (const r of readOutcomeRecords(cwd)) {
    for (const c of r.tool_calls ?? []) {
      if (c.decision !== "deny" || !c.ruleId.endsWith("+declined")) continue;
      if (typeof c.shape !== "string" || c.shape.length === 0) continue;
      const key = `${c.tool}:${c.shape}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const promoted = new Set(loadPromotedDenies(cwd).map((d) => `${d.tool}:${d.shape}`));
  const out: PromotionCandidate[] = [];
  for (const [key, count] of counts) {
    if (count < threshold || promoted.has(key)) continue;
    const sep = key.indexOf(":");
    out.push({ tool: key.slice(0, sep), shape: key.slice(sep + 1), count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}