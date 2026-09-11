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
    if (!d.shape.includes("*")) {
      if (subject === d.shape) return d;
      continue;
    }
    if (/^.+\s\*$/.test(d.shape) && d.shape.indexOf("*") === d.shape.length - 1) {
      // Head form ("echo *"): bare head or head + args. Never over-matches
      // ("echox" must not hit "echo *").
      const head = d.shape.slice(0, -1).trimEnd();
      if (head.length > 0 && (subject === head || subject.startsWith(head + " "))) {
        return d;
      }
      continue;
    }
    // Interior glob (".env.*", "src/*.generated.ts"): `*` spans anything.
    const rx = new RegExp(`^${d.shape.split("*").map(escapeRx).join(".*")}$`);
    if (rx.test(subject)) return d;
  }
  return null;
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
 * Group declined asks by tool:shape into candidates. Hardened against
 * poisoning: needs `threshold` declines across ≥2 distinct runs within
 * `windowMs` (default 30d), counting at most one per run per shape — one
 * bad session spamming declines can't mint a candidate. Skips shapeless
 * declines (no safe generalization) and already-promoted shapes.
 */
export function declineCandidates(cwd: string, threshold = 3, nowMs: number = Date.now(), windowMs: number = 30 * 24 * 3600 * 1000): PromotionCandidate[] {
  const stats = new Map<string, { count: number; runs: Set<string>; newest: number }>();
  for (const r of readOutcomeRecords(cwd)) {
    const ts = Date.parse(r.ts);
    if (!Number.isFinite(ts) || nowMs - ts > windowMs || ts > nowMs) continue;
    const seenInRun = new Set<string>();
    for (const c of r.tool_calls ?? []) {
      if (c.decision !== "deny" || !c.ruleId.endsWith("+declined")) continue;
      if (typeof c.shape !== "string" || c.shape.length === 0) continue;
      const key = `${c.tool}:${c.shape}`;
      if (seenInRun.has(key)) continue;
      seenInRun.add(key);
      let s = stats.get(key);
      if (s === undefined) {
        s = { count: 0, runs: new Set(), newest: 0 };
        stats.set(key, s);
      }
      s.count += 1;
      s.runs.add(r.runId);
      if (ts > s.newest) s.newest = ts;
    }
  }
  const promoted = new Set(loadPromotedDenies(cwd).map((d) => `${d.tool}:${d.shape}`));
  const out: PromotionCandidate[] = [];
  for (const [key, s] of stats) {
    if (s.count < threshold || s.runs.size < 2 || promoted.has(key)) continue;
    const sep = key.indexOf(":");
    out.push({ tool: key.slice(0, sep), shape: key.slice(sep + 1), count: s.count });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}