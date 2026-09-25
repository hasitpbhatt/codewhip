#!/usr/bin/env node
// Recount the parity matrix from its own rows and check the Score section
// against the result. The number in docs/moat/20-parity-matrix.md is the
// program's progress bar, and it was hand-counted wrong once already; a
// percentage nobody can recompute is an opinion.
//
// Two rules the counter encodes, because both were broken by hand:
//   - an arrow in a status cell reads left-to-right, so the FINAL status wins
//     (`GAP-2 → HAVE` is a HAVE, `PARTIAL → GAP-3` is a GAP),
//   - a status the parser does not recognise is an error, never a skipped row.
//     Dropping rows is how a 33% matrix once printed as 46%.
import fs from "node:fs";
import path from "node:path";

const DOC = process.argv[2] ?? "docs/moat/20-parity-matrix.md";
const STATUSES = ["HAVE-plus", "HAVE", "ALIAS", "PARTIAL", "N/S", "GAP"];
const COUNTED = new Set(["HAVE-plus", "HAVE", "ALIAS", "PARTIAL", "GAP"]);

const lines = fs.readFileSync(path.resolve(DOC), "utf8").split(/\r?\n/);
const rows = [];
const problems = [];
for (const [i, raw] of lines.entries()) {
  if (!raw.startsWith("|")) continue;
  const cells = raw
    .replace(/\\\|/g, "\u0000")
    .split("|")
    .map((c) => c.trim().replace(/\u0000/g, "|"));
  if (cells.length < 5) continue; // fewer than 3 real cells: not a matrix row
  const [feature, status] = [cells[1], cells[2]];
  if (!feature || /^:?-{2,}:?$/.test(status)) continue;
  if (status === "Status" || status === "meaning") continue;
  // Final arrow segment, then the leading word of it, with ** stripped.
  const last = status.split("→").at(-1).replace(/\*/g, "").trim();
  const word = last.split(/\s+/)[0] ?? "";
  const wave = /GAP-(\d)/.exec(last)?.[1];
  const known = STATUSES.includes(word) || /^GAP-\d$/.test(word);
  if (!known) {
    problems.push(`${DOC}:${i + 1}: unrecognised status ${JSON.stringify(status)}`);
    continue;
  }
  if (word === "GAP" && wave === undefined) {
    problems.push(`${DOC}:${i + 1}: a GAP row carries no wave number`);
  }
  rows.push({ line: i + 1, feature, status: word.startsWith("GAP") ? "GAP" : word, wave, raw: status });
}

const count = (pred) => rows.filter(pred).length;
const have = count((r) => r.status === "HAVE" || r.status === "ALIAS" || r.status === "HAVE-plus");
const partial = count((r) => r.status === "PARTIAL");
const gap = count((r) => r.status === "GAP");
const ns = count((r) => r.status === "N/S");
const inScope = have + partial + gap;
const pct = ((100 * have) / inScope).toFixed(1);
const byWave = {};
for (const r of rows) if (r.status === "GAP" && r.wave) byWave[r.wave] = (byWave[r.wave] ?? 0) + 1;

// The Score section must say exactly this, or the doc is lying about progress.
const scoreBlock = lines.join("\n").split("## Score")[1] ?? "";
// Only the "Remaining GAP rows by wave" clause, not the wave paragraphs below
// it: those also contain arrows ("GAP 52 → 49") that are history, not a count.
const waveClause = /Remaining GAP rows by wave:([^.]*?)\./.exec(scoreBlock)?.[1] ?? "";
const declared = {
  inScope: /(\d+) in-scope rows/.exec(scoreBlock)?.[1],
  have: /HAVE\/ALIAS\/HAVE-plus (\d+)/.exec(scoreBlock)?.[1],
  partial: /\*\*PARTIAL (\d+)\*\*/.exec(scoreBlock)?.[1],
  gap: /\*\*GAP (\d+)\*\*/.exec(scoreBlock)?.[1],
  pct: /i\.e\. \*\*([\d.]+)%\*\*/.exec(scoreBlock)?.[1],
  waves: [...waveClause.matchAll(/([2-5]) → (\d+)/g)].map((m) => [m[1], m[2]]),
};
const drift = [];
const check = (label, want, got) => {
  if (String(want) !== String(got)) drift.push(`Score says ${label} = ${got ?? "(absent)"}, rows say ${want}`);
};
check("in-scope rows", inScope, declared.inScope);
check("HAVE-or-better", have, declared.have);
check("PARTIAL", partial, declared.partial);
check("GAP", gap, declared.gap);
check("percentage", pct, declared.pct);
const declaredWaves = Object.fromEntries(declared.waves ?? []);
for (const w of Object.keys(byWave)) check(`GAP wave ${w}`, byWave[w], declaredWaves[w]);
for (const w of Object.keys(declaredWaves)) {
  if (byWave[w] === undefined && declaredWaves[w] !== "0") drift.push(`Score says wave ${w} = ${declaredWaves[w]}, rows say 0`);
}

console.log(`${DOC}: ${rows.length} rows (${inScope} in scope, ${ns} N/S)`);
console.log(`  HAVE/ALIAS/HAVE-plus ${have} · PARTIAL ${partial} · GAP ${gap} → ${pct}% at parity or better`);
console.log(`  GAP by wave: ${Object.entries(byWave).map(([w, n]) => `${w}→${n}`).join(" ") || "none"}`);
const open = rows.filter((r) => r.status === "GAP" && r.wave === "2");
if (open.length > 0) console.log(`  wave 2 left: ${open.map((r) => r.feature).join(", ")}`);
for (const p of problems) console.error(`!! ${p}`);
for (const d of drift) console.error(`!! ${d}`);
if (problems.length > 0 || drift.length > 0) {
  console.error(`parity report is inconsistent: ${problems.length + drift.length} problem(s)`);
  process.exit(1);
}
console.log("score matches the rows");
