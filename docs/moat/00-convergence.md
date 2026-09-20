# 00 — Convergence: the single bet

**Converged wedge:** CodeWhip is the terminal agent a team lead can let an intern run on prod-adjacent code at 2am — because every action is policy-checked, memory-scoped, replayable from a redacted audit link, and metered to <$0.05 on polish work.

House order stands: moat = state that compounds (memory > governance > execution >> connectors). H1 = OpenCode parity in terminal. H2 = past Claude Code.

## Debate rulings (no ties)

**1. Loop-first vs Memory-first (leverage vs memory).**
Claim L: ship `agentLoop()` + routed $/task first, JSONL sufficient; DB after 1,000 paid tasks. Claim M: build loop second; routing has zero switching cost, memory is the moat. **Ruling: Leverage wins H1.** Empty memory compounds nothing; zero completed tasks = zero verdicts to recall. Ship loop first with `outcomes.jsonl` as mandatory sidecar so every run seeds future memory. *Cost-of-wrong:* memory-first delays task #1 by weeks, burns solo-builder velocity, ships a diary nobody reads.

**2. Minimal-gov vs Enforcement-gov (leverage/scout vs governor).**
Claim L/S: allow/ask/deny on bash+edit is enough; SSO/audit/policy-DSL is theater until $/task forces adoption. Claim G: policy-as-code + hash-chained audit + sandbox, fail-closed, is the product and leads README/demo/pricing. **Ruling: Governor wins on architecture, loses on scope.** Freeze `codewhip-policy.yaml` + audit-chain schema in H1, but populate only ~5 deny-rules + path jail + non-overridable denylist; defer SSO/signed-team-keys/retention to H2. *Cost-of-wrong:* under-govern = one `rm -rf` ends trust forever (unrecoverable); over-govern = months on enterprise checkboxes nobody pays for yet (recoverable by scoping down).

**3. Ask-default vs --yolo-default (governor vs leverage).**
Claim L: prompts are friction, default to yolo for flow. Claim G: keep `ask` default; kill fatigue with scope (allowlisted safe cmds + sandbox), not blindness. **Ruling: Governor wins.** `ask` default with allowlist (`git status/diff`, `npm test`, `ls`); `--yolo` explicit, logged, bannered; CI `ask=>deny` unless signed `--approve-all`. *Cost-of-wrong:* yolo-default risks catastrophic deletion/exfil — trust loss is terminal; ask-default costs ms per prompt, fixable with one allowlist line.

**4. Audit-senior vs Memory-senior (governor vs memory).**
Claim M: outcomes → memory → policy → check; ship verdict logger before permission lattice; governance is output of memory. Claim G: audit senior to memory; `memory.write` is itself an audited, hash-chained tool call; unverifiable memory is liability. **Ruling: Governor wins.** Every memory/policy mutation goes through policy resolution + `audit.log` entry with `prev_hash`; memory without provenance doesn't ship. *Cost-of-wrong:* unaudited memory is unsellable to any team with compliance and un-debuggable when it poisons generations — liability, not moat.

**5. Launch-gate: engine-proof vs GTM-now (leverage vs scout).**
Claim L: no launch/partnerships/content until `run` does polish at <$0.05 with meter receipts; selling a stub burns credibility. Claim S: thinnest runtime enforcing one policy, then share-link + packs immediately; infra without trust demand is unridden. **Ruling: Leverage's gate wins, Scout's artifact wins.** Build thin runtime first; allow private `--share` links from day one as dev-loop, but no public launch/marketplace push until polish meter proves <$0.05. *Cost-of-wrong:* launching the stub burns dev credibility once and permanently; delaying private shares costs only weeks of weak distribution (recoverable).

**6. Distribution-first vs Retention-first (scout vs memory).**
Claim S: distribution first; memory with no users is disk usage + redaction liability; audit links generate the only memory worth keeping. Claim M: GTM without `outcomes.jsonl` churns every trial user; retention compounds, attention doesn't. **Ruling: Scout wins sequencing, Memory wins invariant.** `init → run → --share` ships H1, but `outcomes.jsonl` + redactor + policy-scoped memory are non-negotiable from run one — distribution must deposit memory. *Cost-of-wrong:* memory-first alone = zero flywheel and enterprise ban over unredacted state; distribution-alone = leaky bucket, one-and-done trials.

**7. Router breadth: 25+ models vs 3 providers (leverage vs scout).**
Claim L: Vercel AI SDK `LanguageModelV2` + models.dev + 3-class router (implement/polish/private) + `--budget` from day one. Claim S: Anthropic + OpenAI + Ollama behind one interface; routing is table stakes/hostage game; add providers when users scream. **Ruling: Scout's scope wins, Leverage's interface wins.** One `LanguageModelV2` interface + classifier + cost meter now, but only 3 providers wired in H1; cheap-model polish path (DeepSeek/Qwen-class) lands as the first routing proof. *Cost-of-wrong:* 75-provider matrix burns month one on undifferentiated abstraction OpenCode/OAuth politics erase quarterly; 3-provider cap costs only a config line per added model later.

## H1 backlog (ordered, solo-builder sized)

P0 — loop that earns:
- [x] P0 `agentLoop()`: messages+tools → stream → permission check → exec → append; Ctrl-C cancels stream + kills tool, keeps transcript; `--max-steps 25` hard stop + partial + cost; `--token-budget` (default 250000) enforced mid-run.
- [x] P0 6 tools (<150 lines each): `read` (offset/limit), `search` (glob+grep merged), `write` (create/overwrite; refuses `.codewhip/**` + `codewhip-policy.yaml`), `edit` (exact + whitespace-insensitive), `bash` (real shell), `git` (status/diff minimal via bash allowlist).
- [x] P0 Provider interface `LanguageModelV2` (openAiPort) + NVIDIA/Mistral only + `--model`/`--provider` override + `--models a,b,c` 429-only rotation (each once per run) + always-on cost meter (`tokens / mix / $`) + `--token-budget` mid-run stop with partial receipt.
- [x] P0 policy jail: harness-side (0 prompt tokens), fail-closed defaults (`read:allow edit/write/shell:ask`) + v1 path jail (realpath, no symlink escape) + non-overridable denylist + explicit `denylist:shell-chaining` (newlines/`;`/`|`/`&`/backtick/`$()`).
- [x] P0 `.codewhip/audit.log` hash-chained JSONL (`seq/ts/actor/tool/args_hash/result_hash/prev_hash/policy/sig`, ed25519-signed with the `init` key, hashes-only at write) + `audit --verify/--last/--replay` + `--export` signed bundle.
- [x] P0 `.codewhip/outcomes.jsonl` written every run (allow/deny + ruleIds, usageByModel, failovers) + `always allow` memory in `.codewhip/remembered.jsonl` (v2: curated shapes, provenance {ts/runId/preview_hash}, self-protecting). Future: `memory.md` + `notes/` + inject (~400 tokens) + `memory distill/approve`.
- [x] P0 `codewhip init` (AGENTS.md + policy digest + keygen) + `codewhip run` (headless + stdin REPL) + auth/models/audit CLI + `run --share` (local redacted bundle, chain-anchored, signed; hosted links need a server).

P1 — trust that spreads:
- [x] P1 3-class router (implement→nvidia / polish→sensenova / private→local-refused) + classifier + override + polish gate line (live <$0.05 proof pending a real priced run).
- [x] P1 `codewhip-action@v1` (same policy in CI, audit trail as artifact; PR comment unwired v1) + 1 starter team pack (`pack pull`, local).
- [x] P1 `policy.md` promotion (3 declines → candidate → 1-cmd approve) compiling to pre-flight denies.

## H2 backlog (ordered)

- [ ] Sandbox profiles: `local|e2b|firecracker` swap behind frozen policy/audit schema; network isolation.
- [ ] Pack registry: versioned team packs, fork/override ranking, private hosting + SSO/retention (paid).
- [ ] Graph memory only on proven pain (>500 outcomes + weekly multi-hop queries): edges derived from `outcomes.jsonl`, Mem0/Zep/Letta evaluated then, never replacing flat files.
- [ ] Full provider matrix + auto-fallback + latency optimization; local-model parity path.
- [ ] Auditor bundle v2 (quarterly export → SOC2 CC7/CC8 mapping doc); redacted public share index as trust corpus.
- [ ] TUI/desktop/IDE only after terminal trusted-runs compound.

## Kill list (final)

1. No custom model hosting, fine-tunes, or model training before 1M+ verdicts.
2. No desktop app / IDE fork / TUI theming in H1 — terminal (SSH-able, CI-runnable) only.
3. No MCP catalog, plugin marketplace, or skills library in H1.
4. No SQLite/Drizzle/event-bus/vector/graph DB in H1 — JSONL + flat markdown only.
5. No SSO/audit-enterprise bundle, policy-DSL sales motion, or compliance-deck-first GTM in H1.
6. No subscription hiding the meter; no yolo-by-default; denylist never removable except explicit `--yolo`.
7. No eval team / prompt guild / AI consultancy; anything needing humans per task is anti-leverage.
8. No public launch, partnerships, or content flywheel until polish <$0.05 with receipts; no unbounded memory without redaction + policy scope.

## Metrics (with target bars)

- **Task success %** (multi-step edit completes + tests pass, no human rescue): H1 bar ≥70% polish / ≥50% implement; measure per `outcomes.jsonl` verdicts.
- **Violations blocked** (deny/ask-fire per 100 runs + zero jail escapes): H1 bar ≥5 blocks/100 runs caught in demo, 0 escapes; audit `--verify` 100% pass.
- **$/task** (metered, by class): H1 bar polish <$0.05, implement <$1.50, blended <$0.50 default budget; print every run.
- **Memory lines accrued/week** (promoted `memory.md`/`policy.md` lines surviving 30d, not raw logs): H1 bar +3–5 durable lines/repo/week, revert-rate on memorized patterns trending down.
- **Trusted runs/team/week** (runs with zero bypasses + shared audit): H1 bar ≥4–5/week for pilot teams; north-star for H2 pricing (free → $20 pro → $40 team).

## Rulings log (additive, newest last)

- 2026-09-10 — **Memory mutation schema change (Ruling 4 compliance).**
  "Always allow" memory moves out of `codewhip-policy.yaml` into a dedicated
  append-only `.codewhip/remembered.jsonl`, one rule per line with provenance
  `{tool, shape, ts, runId, preview_hash}`. Two hardening fixes land with it:
  (1) shapes are CURATED — only a short allowlist of heads may be remembered,
  and redirects/pipes/chains are unmemorable, closing the
  `echo x > .git/hooks/*` over-permit; (2) the harness self-protects — writing
  `.codewhip/**` or `codewhip-policy.yaml` is refused by both the new `write`
  tool and the memory path. `codewhip-policy.yaml` keeps deny + defaults only.
  Ruling 4 (unverifiable memory doesn't ship) is what forces the provenance
  fields; policy/memory stay harness-side and token-free by construction.

- 2026-09-10 — `outcomes.jsonl` v1 stays frozen: retry/failover lands as
  OPTIONAL `usageByModel[]` + `failovers[]` only (`v:1` literal, all existing
  fields byte-identical). Old readers ignore unknown keys; no migration.

- 2026-09-11 — **Audit chain ships (Week-3 P0 closes).** `src/audit.ts`:
  every tool call is appended to `.codewhip/audit.log` with
  `{v,seq,ts,runId,actor,tool,args_hash,result_hash,prev_hash,policy,sig}`,
  ed25519-signed with the `init` keypair, hashes-only at write (redaction by
  construction; result hashes match outcomes byte-for-byte). `--verify`
  re-walks seq/prev_hash/signatures; `--replay` renders; `--export` writes a
  signed content-addressed bundle (`chain_tail` anchors the tail). 92/92 tests.

- 2026-09-11 — **`run --share` ships (local redacted bundle, no server).**
  `src/share.ts`: prompt, per-tool previews (already redacted at the model
  boundary), policy verdicts, receipt — scrubbed again for key-shaped
  tokens/PEMs/emails plus env-assignment values (names kept), anchored to
  `audit.log` via `audit_tail`, signed when a key exists. LoopResult gains
  `runId` + per-call `trace`. The "link" is the bundle path + content hash;
  hosted/public links need a server and stay out of H1. 101/101 tests.

- 2026-09-11 — **3-class router ships (P1 mechanism, gate still OPEN).**
  `src/router.ts`: keyword classifier (private > polish > implement) with
  printed reason; `--class`/`--provider`/`--model` always override; private
  prompts refuse cloud routing without an explicit provider (informed
  consent). Priced-route table (only nvidia free tier known; the rest
  untracked, never fiction); polish gate printed per run. The <$0.05 launch
  gate needs a real priced polish run — mechanism landed, proof pending.
  111/111 tests.

- 2026-09-11 — **`codewhip metrics` ships (bars readable, verdicts honest).**
  `src/metrics.ts`: aggregates `outcomes.jsonl` + remembered rules into runs,
  allow/deny, blocks/100, priced spend ($/task on known routes, untracked
  counted never fiction-priced), memory lines/week. Task success stays
  "unmeasurable" until verdict instrumentation exists — reported, not faked.
  116/116 tests.

- 2026-09-11 — **Policy promotion ships (P1 flywheel seed).**
  `src/policy-store.ts`: declines persist their shape (optional outcomes
  field, freeze-compatible); 3+ declines of a tool:shape →
  `policy candidates` → `policy approve` appends `deny` to committable
  `policy.md` → denied pre-flight from the next run (`policy.md:deny:…`
  pointer). Deny-only file; denylist still wins. 127/127 tests.

- 2026-09-11 — **CI + packs ship (last H1 box).** `.github/workflows/ci.yml`
  pins the $0 suite; `actions/run/action.yml` runs the agent headless
  (ask⇒deny, never yolo) and uploads `.codewhip/` — PR commenting unwired
  until a team reviews trails first. `packs/starter/` + `pack list/pull`
  (local copy; registry is H2). Interior-glob matcher added so shipped
  denies (`.env.*`) actually deny. 133/133 tests. **H1 backlog complete.**

- 2026-09-11 — **Roadmap trim + SOUL stage update.** `docs/roadmap.md` removes shipped H1 P0/P1 items and adds the Next post-H1 polish list sourced from `docs/moat/06-post-h1-verdict.md` (pasteable share, passable gate, truth to model, pack honesty, reporting honesty, drift/hygiene). Weekly sequencing removed as obsolete. `SOUL.md` stage updated from pre-implementation/stub to H1 core shipped with launch gate OPEN. No scope creep; frozen schemas unchanged, rulings remain additive only.

- 2026-09-12 — **Ruling addendum: subagents overturn recorded.** The
  committee's kill-list call on subagents assumed delegation would fork the
  audit model (which agent's seq appends next). Implementation proved the
  premise wrong: the audit chain is global (seq/prev_hash derived from the
  tail per append, mkdir-locked), so nested runs compose onto one chain
  under their own runIds. Subagents shipped read-only (plan-mode children,
  depth cap 1, budget-inheriting, receipt-honest usage folding, per-child
  outcome records with `parent_run_id` for metrics de-dup) — delegation
  grants no authority beyond read/search/webfetch and widens the audit
  surface. Full reasoning and committee re-review: `docs/moat/*-subagents-review.md`.

- 2026-09-14 — **Sessions schema v1 (multi-turn, opt-in).** `src/sessions.ts`
  persists one `{ v: 1, ts, runId, provider, model, messages }` object per run
  at `.codewhip/sessions/<runId>.json`, rewritten (not appended) at end of
  each `--continue` run. `outcomes.jsonl` keeps `prompt_hash` only; the
  session file holds raw prompts by design, so writes happen exclusively
  under an explicit `--continue` arm (banner + `raw prompts on disk` notice),
  with `redactSecrets` at write time, `mkdir 0o700` / file `0o600`, and the
  system message stripped (rebuilt fresh on resume — roster/plan banner
  drift between runs). `share.ts` bundles never sweep `sessions/`; the REPL
  threads one in-memory transcript and saves once on `.exit`. Session-scoped
  (`s`) approvals stay per-invocation in v1 — noted follow-up, no scope creep.

- 2026-09-17 — **H1 marked DONE, launch gate WAIVED (explicit decision).**
  Polish <$0.05 is unproven *by construction*: `routeFor("polish")` targets
  sensenova, which has no `PRICE_PER_1K` entry, so `polishGate` can never
  pass. Docs-only close-out (zero per-run cost, no runtime change):
  `docs/roadmap.md` Build status → DONE with the waiver recorded (not a
  pass), kill-list rule 8 launch half annotated waived (memory half holds),
  `SOUL.md` stage flipped, Undo checkbox ticked (already shipped:
  `src/checkpoints.ts` + loop snapshots + `rollback` CLI). Next slice:
  pack honesty (starter-pack denies must fire on both `edit` and `write`).

- 2026-09-17 — **Launch gate PASSED with a real priced run (supersedes the
  WAIVED ruling the same day).** Polish re-routed from untracked sensenova
  to the verified-$0 kilo hop (`cohere/north-mini-code:free`, in
  `PRICE_PER_1K` since 2026-09-11, 97% ok over 120 local calls): un-overridden
  auto-route run `28589c84` fixed 12 typos to verdict `accepted`,
  receipt 14977+1449 tokens / $0.0000 < $0.05, `polish gate: PASS` printed.
  No fiction-pricing — the $0 is the verified free-tier entry, the run is
   metered, the verdict is recorded. Kill-list rule 8 launch half satisfied.

- 2026-09-18 — **TUI spike converged (OpenTUI, headless default).** Full
  verdict: `docs/moat/05-tui-spike.md`. No `LoopEvent` widening (bridge =
  approval-as-promise, fail-closed `no`); lazy optional import, headless
  builds/tests with pkg absent; `src/tui/{bridge,model,view}` <300 lines.
  Ship: transcript-thin + composer + meter, y/s/a/n + revoke hint, ~15-line
  `captureBefore` preview, rollback footer (no picker), 500ms poll tail-only,
  `/model /free /plan /rollback /sessions`, Esc/Ctrl-C parity, `--no-tui`
  fallback. Kill: queue (zero), markdown/diff-rich, pickers, themes, mouse,
  streaming, share-hosted, history file, new persisted files. Zero new
  writers — persistence/redaction/perms via existing contracts only.

- 2026-09-20 — **Verdict-driven privilege track OPENED (C3; ML venue frame).**
  Plan approved: single bet = induce per-repo least-privilege tool permissions
  from one-bit human verdicts + near-miss co-signals, measured escape vs
  autoimmune. Core/surface separated WITHOUT deletion: `ProviderId` moved to
  the `provider-port` leaf, router/models/free-providers/metrics reclassified
  surface, `src/boundary.test.ts` pins the rule "core never imports surface".
  Instrumentation (all additive, freeze-compatible): human-approved asks now
  record their generalizable shape on the outcome call (positives; declines
  were already labeled), `src/immunity/` ships samples (labeled event stream),
  rules (AST compiled to matcher-identical deny shapes), and the 67-case
  adversarial escape suite (`npm run immunity`). First run of the suite
  caught a REAL escape: `remove-item -recurse -force src` asked instead of
  denying because `flagSet` expands single-dash long flags to letters while
  the force check demanded the literal word — the pre-existing test used an
  absolute path and denied via worktree containment, masking the hole
  (vacuous assertion, since fixed with relative-target tests). Post-fix:
  0/55 escape, 0/12 autoimmune. Registry/serve/TUI frozen as product surface,
  zero research dependency.
- 2026-09-20 (same track) — Audit closure + first experiment. Verdicts wired
  into the miner (decline weight by run verdict: reverted/rejected 2, edited
  1, accepted 0.5, unjudged 1); approvals pinned by ruleId (only bare-ask /
  +session / +always grants are positives); chronological train/held-out
  split (`splitEvents`). `simuser.ts` + `npm run immunity -- --sim`: seeded
  synthetic corpora (3 archetypes × habit shapes × misclick noise), Figure 1
  skeleton — two-signal holds 89.1% coverage at 2.0% over-block while
  count-only needs 10.2% over-block just to reach that coverage (final
  47.9%). The sim falsified the naive veto on its first run: one 1-in-20
  misclick approval permanently disarmed a true-danger rule. Refinement now
  pinned by tests: the veto is verdict-aware (regret approvals from
  reverted/rejected runs are not evidence) and demands a habit
  (`vetoMinRuns: 2` distinct calm runs), not a single bit.
