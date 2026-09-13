# Product panel review — shipped surface coherence ("the paper claims excellence; the product must hold up")

**Panel:** 5 voices — (1)(2) developer-tools product leads, (3) open-source community
person, (4) docs/technical-writing lead, (5) design-systems engineer.
**Reviewed:** README.md (full), CHANGELOG.md, docs/roadmap.md, `src/index.ts` help text,
and the CLI itself: `help`, `help <cmd>` (x8), `init` (fresh temp dir), `demo --deny`
(fresh + dev repo), `trust` (human + `--json`), `audit --verify`, `agents`, `free`,
`metrics`, `stats`, `pack list`, error paths (bad provider / unknown command / bare
`policy` / no-prompt `run`), and one live keyless run (`run "Say OK" --provider llm7`).

---

## Voice 1 — Dev-tools product lead (first-run funnel)

The funnel **mechanics** are genuinely above MVP bar: `init` ends with the exact next
command (`done. next: codewhip demo --deny (offline, $0) — then: codewhip auth login
nvidia`); on a fresh repo `demo --deny` exits 0 with the bar met (`5 denied / 1 allowed
(bar: ≥5 blocks in demo)`) and a $0 receipt; a live `run` prints route → auth note →
output → receipt → verdict footer (`record judgment: codewhip verdict be1c5356
<accepted|…>`). That footer closing the loop into `metrics` is the best UX decision in
the product. But three stalls:

1. **The funnel is invisible in the README.** Quickstart (lines 36–47) jumps straight to
   `auth login` + `run`. The one command that needs no key and proves the wedge —
   `demo --deny` — appears nowhere in README as a command (verified: zero occurrences of
   `codewhip demo` / `demo --deny`). A cold user following the README never sees the
   funnel the CLI itself advertises.
2. **In any repo with pre-key audit history, the funnel red-screens.** In the dev repo,
   `demo --deny` exits **1** and prints `audit: chain BROKEN` — while `trust` on the same
   log says `INTACT (pre-key entries unsigned as expected)`. `audit --verify` agrees with
   demo (strict) and disagrees with trust (lenient): 13 "unsigned while a key exists"
   flags. Two verifiers, one truth, and the intern at 2am hits the contradiction on step 2.
3. **`TRUST: NEEDS WORK` on a fresh, correct install.** After init+demo on a clean dir
   (chain 6/6 signed, policy active, keys present) the verdict is still NEEDS WORK with
   next step `codewhip run --class polish "..." (prove <$0.05)` — which a free-tier user
   can *never* satisfy (no priced route). The funnel dead-ends at NEEDS WORK forever for
   $0 users. The verdict conflates "broken" with "unproven".

## Voice 2 — Dev-tools product lead (command surface)

17 top-level commands + subcommand families. Per-command help (`codewhip help <cmd>`,
`<cmd> --help`) is real, consistent, and ends with next-command pointers — better than
most funded CLIs. Dead-end errors name the remedy (`unknown provider "nonexistent"
(see: codewhip provider list)`). That said:

- **`metrics` vs `stats` is a naming collision.** Both are "aggregate health over a
  JSONL": `metrics` = H1 bars from `outcomes.jsonl`; `stats` = per-provider request
  health from `provider-analytics.jsonl`. Nothing in the names, root help, or either
  output cross-references the other. Cheapest fix: one `see also` line in each.
- **`agents` breaks the grammar.** `policy`/`pack`/`provider`/`auth` are noun-commands
  with subcommands; `agents` is a bare listing verb-noun. `agent list` would be
  consistent — or accept it and document the inconsistency away.
- **`-v, --version` is listed under "Options (run)"** (`src/index.ts:82`) but is global.
  Misfiled in the one surface power users read.
- **`stats` truncates model names to `m:`** — `nvidia: m: 55% (142/260)` and
  `pollinations: m: 100% (113/113)` are useless rows (full ids render fine elsewhere in
  the same output). Looks like a truncation bug, not a choice.
- **`free` header overclaims:** `44, verified 2026-09-11` — but 18 of those rows joined
  2026-09-13 and README itself admits they are "catalog-derived rather than live-probed."
  For a product whose brand is honesty, the verified date must be per row, not a blanket
  stamp.

## Voice 3 — Open-source community person (the trust certificate)

The concept is exactly right — one command a team lead runs before letting anyone loose,
`--json` for CI. The execution has five nits, two of which matter:

1. **It disagrees with `audit --verify` on the same log** (see Voice 1.2). This is the
   one a community member files as their first issue: "which verifier do I believe?" The
   pre-key leniency carve-out is defensible; having it in one command and not the other
   is not. Ship one verifier, one status word, and let trust *annotate* leniently
   ("13 pre-key unsigned — expected, key added later").
2. **"42 missing" keys is fear-mongering arithmetic.** The registry now has 51 builtins;
   42 "missing" counts paid gateways (bai, fabryka, xai…) nobody on the free path needs.
   A lead reads "42 missing" as "I configured this wrong." Split: free-chain missing
   (actionable) vs paid/optional (informational).
3. `3 base deny(es) + 0 promoted deny(es)` — the pluralization helper leaked into user
   output, twice, in the flagship artifact.
4. The verdict needs a third tier: PASS / **UNPROVEN** (fresh + clean, gate not yet
   proven) / NEEDS WORK (real breakage). Fresh-clean reading "NEEDS WORK" trains users
   to ignore the verdict.
5. `nextSteps` order differs between human output and `--json` — trivial, but the JSON
   is the CI contract; make them identical.

## Voice 4 — Docs/technical-writing lead (README)

Voice and honesty notes are an asset — the free-tier rot disclosures (cerebras/chutes/
lepton) are the kind of thing incumbents never write. But:

- **`codewhip trust` appears nowhere in the README.** Zero occurrences. The single
  artifact the paper is about — the trust certificate — is documented only in the
  CHANGELOG. Same for `codewhip agents`, `codewhip stats`, `codewhip demo`. The README's
  "How it works (design)" is excellent prose; the command surface that backs it is
  under-documented by exactly the four commands that differentiate the product.
- **README/receipt contradiction on the core honesty claim.** README: "Every free-tier
  default is priced `$0` on the receipt." Live keyless run:
  `receipt: 1306 prompt + 2 completion tokens / llm7:default 1306+2 / cost untracked
  (see https://dash.llm7.io)`. Either price known free defaults or qualify the claim
  ("free-chain runs via `--free`"; the explicit `--provider llm7` path with the
  catalog-less `default` model id prints cost untracked).
- **`codewhip verdict` is never documented.** `metrics` prints "task success:
  unmeasurable — no verdicts recorded yet" and the run footer begs for it, but the
  command that closes the measurement loop is README-invisible.
- **Length:** 481 lines with the quickstart at line 34. The paper-adjacent features
  (subagents §"Subagents", rollback, `--plan`) each have good sections but no 10-line
  "delegate → trust → verdict" quickstart tying them to the wedge. A reader who wants
  *only* the governance story can't find it fast.
- **Machine-specific install text:** "global bin `C:\Users\Lenovo\AppData\Roaming\npm`
  is already on your `PATH`" — a personal path in a public README.
- **Versioning:** package.json is 0.1.0 while CHANGELOG [Unreleased] holds everything
  shipped since (trust, subagents, compaction, rollback, 51 providers). Artifact
  evaluation checkpoints versions — cut and tag 0.2.0 before submission.

## Voice 5 — Design-systems engineer (output system)

The bones are consistent and good: `—` separators, aligned columns (`agents`, `free`),
the ⚠ legend in `stats`, ◆ for compaction, `[builtin]`/`[file]` source tags, honest
`est.` marks. Violations against the system's own rules:

- **The Keys wall.** `printKeysHelp()` (`src/index.ts:85-93`) renders the registry as
  two unbroken ~1,000-character lines (50 env vars, then 50 consoles) appended to root
  help, `help run`, and `help auth`. Registry-derived generation is nice engineering;
  the output is unreadable and repeated three times. Cap the default to the four keyless
  ids + one pointer; keep the full dump behind a `codewhip help keys` topic.
- **Receipt duplication:** `1306 prompt + 2 completion tokens / llm7:default 1306+2 /
  cost untracked` — the same numbers print twice in one line in two notations. One
  canonical form: `tokens: 1306p + 2c / llm7:default / cost untracked`.
- **Exit codes encode world state, not command success.** `demo --deny` met its bar and
  exited 1 (chain state leaked into the exit path); `audit --verify` exiting 1 on
  BROKEN is right — but then `trust` must never call the same state INTACT. Rule: exit
  code = did the command do what it was asked; status words = world state.
- **Pluralization is inconsistent across outputs:** `deny(es)` (trust), `rule(s)`,
  `file(s)`, `run(s)`, `entry(s)` elsewhere. Pick one convention (singular when 1, else
  plural) in one helper.
- **`free` is a 90-line wall with no compact mode.** Add `--json` (parity with `trust`)
  or `--keyless` filter; the list is reference material, not a default read.

---

## Consensus

The shipped surface is closer to the paper's claim than most MVPs get: the init→demo→run
chaining works, per-command help is real and consistent, error paths name remedies, the
run receipt + verdict footer is genuinely good closed-loop UX, and the honesty
disclosures are a differentiator. But the product's brand is **verifiable trust**, and
its own surface violates verification three ways: two chain verifiers disagree
(trust=INTACT vs audit --verify/demo=BROKEN on identical state), the flagship `trust`
command is absent from the README, and two honesty-adjacent copy lines ("$0 on the
receipt", "verified 2026-09-11") run ahead of what receipts/rows actually show. All five
reviewers independently flagged the verifier disagreement first. Every finding below is
a same-day fix; none requires schema or policy changes.

## Top 3 fixes for artifact evaluation

**Fix 1 — One chain verdict, everywhere (trust / audit --verify / demo).**
Make `trust` and `audit --verify` call one verifier with one status word; trust may
*annotate* leniently but must not contradict. Concretely: export the pre-key leniency
from `src/audit.ts` (`verifyChain({ allowPreKeyUnsigned: true })`) and use it in both
paths; trust prints `audit chain: INTACT (25 entries, 12 signed, 13 pre-key unsigned —
expected)`; `demo --deny`'s exit code keys off the demo bar only (bar met ⇒ exit 0),
never off chain state. Acceptance: `trust` and `audit --verify` never disagree on status
in the same repo; `demo --deny` exits 0 whenever `5 denied / bar ≥5` is met.

**Fix 2 — README: surface the wedge artifact and the funnel it hides.**
After the Quickstart block (README line 47) insert:
```sh
codewhip demo --deny              # offline wedge demo, $0, no key — five disasters refused
codewhip trust                    # trust certificate: chain, policy, gate, memory, keys, verdict
codewhip agents                   # list delegable read-only subagents (explore/review/plan)
codewhip verdict <runId> accepted # close the loop — feeds task-success metrics
```
plus one 8-line sample `codewhip trust` output under "Why CodeWhip" (it *is* the paper's
artifact) with the UNPROVEN tier once Fix 3 lands. Correct the two honesty lines: qualify
"Every free-tier default is priced $0 on the receipt" to the `--free` path (or price the
known free defaults), and make `free`'s verified date per row. De-personalize the
install section (drop the `C:\Users\Lenovo\…` path). Cut **0.2.0**: CHANGELOG
`[Unreleased]` → `[0.2.0] — 2026-09-13`, bump package.json, tag — evaluators checkpoint
versions, and the badge-worthy diff (trust + subagents + compaction) is currently
invisible to them.

**Fix 3 — Trust certificate + help formatting pass (~an hour, reads as care).**
- `src/index.ts` trust block: fix the plural helper (`3 base denies + 0 promoted denies
  active`); add the UNPROVEN verdict tier for fresh-clean repos; make `nextSteps`
  order identical in human and `--json` output; add a `violations blocked` line
  (`metrics` already computes blocks/100 — the paper's own bar belongs on the certificate).
- Keys: split trust's `42 missing` into free-chain-missing vs paid-optional.
- `src/index.ts` `printKeysHelp()`: default output = 4 keyless ids + `codewhip free` /
  `codewhip auth status` pointers; move the full env/console dump to a new
  `codewhip help keys` topic.
- Remove `-v, --version` from `printRunOptions()` (`src/index.ts:82`); it is global.
- `stats`: fix the model-name truncation rendering as `m:`; receipt: one token notation
  (`tokens: 1306p + 2c / …`), no duplication.
