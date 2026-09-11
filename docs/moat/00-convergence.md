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
- [ ] P0 `.codewhip/audit.log` hash-chained JSONL (`seq/ts/actor/tool/args_hash/result_hash/prev_hash/policy/sig`) + `audit --verify/--last/--replay` + secret redaction at write + `--export` signed bundle.
- [x] P0 `.codewhip/outcomes.jsonl` written every run (allow/deny + ruleIds, usageByModel, failovers) + `always allow` memory in `.codewhip/remembered.jsonl` (v2: curated shapes, provenance {ts/runId/preview_hash}, self-protecting). Future: `memory.md` + `notes/` + inject (~400 tokens) + `memory distill/approve`.
- [x] P0 `codewhip init` (AGENTS.md + policy digest + keygen) + `codewhip run` (headless + stdin REPL) + auth/models/audit CLI. Future: `--share` redacted link.

P1 — trust that spreads:
- [ ] P1 3-class router (implement→Sonnet-class / polish→cheap Flash-class / private→local) + proven <$0.05 polish receipt before any launch.
- [ ] P1 `codewhip-action@v1` (same policy in CI, audit link posts to PR) + 1 starter team pack (`pull team/starter-rails`-equivalent).
- [ ] P1 `policy.md` promotion (3 consistent rejections → candidate → 1-cmd approve) compiling to pre-flight grep/lint blocks.

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
