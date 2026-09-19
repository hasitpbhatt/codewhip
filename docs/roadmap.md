# CodeWhip Roadmap — the consolidated bet

Source of truth for build order. Converged from the five Naval agents' debate
(`docs/moat/00-convergence.md` — 7 rulings, no ties). Soul and principles:
`SOUL.md`. Per-agent findings: `docs/moat/01–04`.

**Wedge:** CodeWhip is the terminal agent a team lead can let an intern run on
prod-adjacent code at 2am — policy-checked, memory-scoped, replayable from a
redacted audit link, metered to <$0.05 on polish work.

**Horizons:** H1 = OpenCode parity in the terminal, with enforcement-grade
governance. H2 = credible open alternative to Claude Code's closed trust.

## Build status

H1 DONE (2026-09-17). `codewhip run` is live (loop, tools, policy jail, audit chain, outcomes+remembered, init/run/--share, 3-class router mechanism, CI + packs, policy promotion). Launch gate PASSED with a real priced run: polish auto-route (kilo:cohere/north-mini-code:free, priced $0) fixed 12 typos to verdict `accepted` at $0.0000 < $0.05 (run `28589c84`, receipt on file).

## Next (post-H1 polish)

Ordered from `docs/moat/06-post-h1-verdict.md` P1 items 3–8 and the
five-persona committee verdict (`docs/moat/07-committee.md`). All are implementation hygiene, no scope creep.

- [x] **Undo** — automatic per-run file checkpoints on edit/write (before-image + sha256 manifest, JSONL, self-protecting) + `codewhip rollback <runId-prefix> [--list]`. *(committee ruling 1 — shipped: `src/checkpoints.ts` + loop snapshots + `rollback` CLI; checkbox ticked 2026-09-17)*
- [x] **Plan mode** — `--plan` denies edit/write/bash run-scoped, above ask and above `--yolo`; the run's output is the plan. *(committee ruling 2 — shipped 2026-09-11)*
- [x] **Compaction** — sessions survive the context window with honest receipt lines ("compacted: N tool outputs dropped…"). *(committee ruling 3 — shipped 2026-09-11: two-tier prune, chars/4 est. ceiling, on by default)*
- [x] **Subagents & delegation** — read-only child runs (`delegate`, `delegate_many` ≤4 concurrent) behind declarative `.codewhip/agents/` files + 3 built-ins; depth-capped, plan-mode children, child calls on the global audit chain under their own runIds, child usage folded into the parent receipt. *(shipped 2026-09-12 — overturns the earlier committee kill-list call, which assumed delegation would fork the audit model; the global chain composes instead)*
- [x] **Trust certificate** — `codewhip trust` prints chain/policy/polish-gate/memory/keys state with contextual next steps (`--json` for CI). *(shipped 2026-09-12)*
- [x] **REPL slash commands** — `/model` switches provider/model live (TUI: the loop picks up the staged port at the next turn boundary via `takePendingSwitch`; receipts split per model); `/free` prints in-run free-chain visibility; `/plan` states honestly that plan mode is run-scoped. *(shipped 2026-09-18)*
- [x] **Pasteable artifact** — `run --share --print` prints a Markdown receipt block anchored to the audit chain. *(shipped 2026-09-17: `renderShareMarkdown` + `--print` flag, audit_tail + bundle hash + sig line)*
- [x] **Passable gate** — polish re-routed to priced $0 kilo hop; real run `28589c84` passed at $0.0000 with verdict `accepted`. *(shipped 2026-09-17 — supersedes the WAIVED ruling the same day)*
- [x] **Truth to model** — reword tool specs so the model does not believe chaining is permitted; fix the search comment that incorrectly claims `read` skips secrets. *(Repeat-call guard shipped 2026-09-12: identical idempotent calls are memoized in-run, cleared on edit/write, recorded as `allow:loop:repeat-call`. System prompt grew env/git/comms/delegation steering 2026-09-18.)*
- [x] **Pack honesty** — starter-pack `.env*` denies fire on both `edit` and `write` (`deny write:` twins, pinned by a content-vs-enforcement test). *(shipped 2026-09-17)*
- [ ] **Reporting honesty** — decision buckets (allow/deny/remembered/policy), untracked spend handling, `--last`/`--replay` parity, empty export failure, `missing===2` clarity.
- [ ] **Drift + hygiene** — settle tool count wording, single-shot vs REPL labeling, receipt legend for $ tracking, polish-gate label wording, dead branches, REPL receipt, remove vacuous assertions. *(partial 2026-09-18: budget/TUI dead code and the stale `src/lib` registry fork removed — the lib now shares the CLI's Node-free registry leaf with drift-guard tests)*
- [x] **Multi-turn sessions** — `run --continue [prefix]` resumes the newest (bare) or one (≥4-char unique prefix) saved transcript and persists the post-compaction transcript on every loop exit path; `codewhip sessions` lists newest-first with redacted previews; REPL threads one in-memory transcript and saves once on `.exit` *(shipped 2026-09-14 — sessions v1, opt-in, redacted, system-stripped)*
- [x] **Measured task success** — the H1 bars (≥70% polish / ≥50% implement) were demanded but never measured. `codewhip eval` runs the agent against 12 fixture tasks in disposable temp dirs, machine-grades each with its checker (graders validated fail-on-raw/pass-on-solved), records `.codewhip/eval.jsonl`, and `codewhip metrics` reports the per-class bars. *(shipped 2026-09-18 — mechanism per `docs/moat/10-competitive-reality.md`; bars still need real runs)*
- [x] **Verdict crank** — verdicts (the claimed compounding moat) were written only by manual CLI call. `codewhip verdict --auto <prefix>` proposes accepted/edited/reverted from checkpoint manifests vs the tree (git cross-check, confidence + evidence printed) and records on one keypress; the judgment stays human-attached. *(shipped 2026-09-18)*
- [x] **Tool-layer honesty fixes** — `read` refuses binary files (null-byte sniff) instead of feeding mojibake to the model; `edit`'s whitespace-insensitive fallback preserves the file's dominant EOL (CRLF files no longer silently flip to mixed endings); `search` skips `target`/`vendor`/`__pycache__`/`build` so build trees stop eating the 2,000-file budget. *(shipped 2026-09-18)*
- [x] **Torvalds architecture review (5 simulations)** — converged verdict: no full rearchitect; core (ChatPort seam, loop ledgers, chain math, ladder precedence) KEEP. Fixed same pass: the src/lib phantom product deleted (placeholder proxy, broken Workers path, drifted routers), memo redaction bypass, memo staleness after bash, denylist spelling escapes (git.exe/quote-splice/cmd.exe/iex/braces), audit lock spin < stale threshold + silent entry loss (now loud, `audit_dropped` on the outcome), signed genesis marker bounding the pre-key prefix, rotation×/model foreign-id bug (candidates pre-resolved on the head provider), Windows process-tree kill, model-aware compaction (verified `contextWindow` + CJK-weighted estimate + context-overflow 400s join rotation). Deferred with rationale: jail TOCTOU, key rotation, jsonl contract consolidation, parallel tool exec, audit tail caching. *(2026-09-18 — docs/moat/torvalds-architecture-review.md)*
- [ ] **Pick the 90-day frame** — verifiable team delegation vs honest $0 on-ramp; running both produces a brand war (trust pitch vs anonymous free relays). Decision + analysis: `docs/moat/10-competitive-reality.md`.
- [ ] **Paper track: physiology frame recorded, track CLOSED** — "A Physiology of Agent Harnesses" scaffold: mechanism→organism mapping with code anchors (metabolic ceiling, consolidation, Kleiber allometry for subagent budgets, habituation memo, innate/adaptive immunity, homeostatic routing), prior-art positioning (AgentAntibody, bio-motifs 2607.04240), three contributions (C1 robustness metrics, C2 the unmeasured allometric exponent, C3 danger-theory decline mining). Reopens only on the recorded triggers: real eval numbers + 90-day frame + telemetry. *(2026-09-18 — docs/moat/15-agent-physiology.md)*

## H2 backlog (ordered)

- [ ] Sandbox profiles `local|e2b|firecracker` behind the frozen v1
  policy/audit schema; network isolation.
- [ ] Pack registry: versioned team packs, fork/override ranking, private
  hosting + SSO/retention (paid tiers: free → $20 pro → $40 team).
- [ ] Graph memory **only on proven pain** (>500 outcomes + weekly multi-hop
  queries): edges derived from `outcomes.jsonl`; Mem0/Zep/Letta evaluated
  then; flat files never replaced.
- [ ] Full provider matrix + auto-fallback + latency optimization; local-model
  parity path (free-tier slice shipped 2026-09-11: 8 free gateways — 4 keyless
  (kilo/opencode/empero/llm7) — plus `codewhip free` and the `--free` chain;
  SSE streaming + first-byte/idle timeouts + timeout-classification fix shipped
  2026-09-12; +18 free-key tiers and the lepton/chutes/cerebras rot repair
     shipped 2026-09-13 — 53 builtins, 44 free-chain hops at the time; 2026-09-18
   trial-credit repair + completeness batch — 95 builtins, 43 free-chain hops:
   one-time signup grants are not free, so xai/novita/qianfan/deepseek/ppio/
   scaleway/friendli/nscale/nebius/ai21 left the chain but stay reachable via
   `--provider`; 15 providers added (githubmodels, aihubmix, fastrouter,
   vercel, zenmux, llmgateway, suyu, voapi, nio join the chain; together,
   deepinfra, fireworks, cometapi, mkeai, apiyi stay out as trial/paid). Also
   added 2026-09-13:
  `1min` as the first non-OpenAI-shaped provider (its own `port: "onemin"`
  adapter: flattened prompt, prompt-injected tool calls, estimated usage) and
  `codewhip serve`, an OpenAI-compatible HTTP front end over the whole registry
  — which is what lets a client that cannot speak 1min's schema still use it.
  `hcnsec` (api.hcnsec.cn, a keyed New API relay) joined 2026-09-14, outside
  the free chain — as did `hashneuron` (hashneuron.space, the RouteOpen gateway;
  default model id `default`, which its own console labels "Auto"). Both stay
  out of the chain because their free grants are quota/prepaid-metered rather
  than a fixed non-billing tier.
  The local-model parity path landed 2026-09-14: `custom-providers.ts` now
  accepts `http://` on loopback only, and `routeFor("private")` routes to a
  registered loopback provider — still refusing when none is registered, or when
  several make the choice ambiguous.
  2026-09-16 ruling: serve regains a `GET /stats` page — aggregated
  provider/model health only (the same summarizeCalls view auto-routing
  reads). Per-request history stays unserved, as removed in d8f784f; the
  bearer gate covers `/stats` like `/playground`.
- [ ] Auditor bundle v2 (quarterly export → SOC2 CC7/CC8 mapping doc);
  redacted public share index as trust corpus.
- [ ] TUI/desktop/IDE only after terminal trusted-runs compound.

## Kill list (final — needs evidence to reopen)

1. No custom model hosting, fine-tunes, or training before 1M+ verdicts.
2. No desktop app / IDE fork / TUI theming in H1 — terminal
   (SSH-able, CI-runnable, scriptable) only.
3. No MCP catalog, plugin marketplace, or skills library in H1.
4. No SQLite/Drizzle/event-bus/vector/graph DB in H1 — JSONL + flat markdown.
5. No SSO/enterprise bundle or compliance-deck-first GTM in H1.
6. No subscription hiding the meter; no yolo-by-default; denylist removable
   only via explicit `--yolo`.
7. No eval team / prompt guild / consultancy; humans-per-task is anti-leverage.
8. No public launch, partnerships, or content flywheel until polish <$0.05
   with receipts (satisfied 2026-09-17: run `28589c84`, $0.0000, verdict
   `accepted`); no unbounded memory without redaction + policy scope
   (still holds).

## Metrics (bars — readable via `codewhip metrics`)

| Metric | Definition | H1 bar |
|---|---|---|
| Task success % | multi-step edit completes + tests pass, no rescue (from `outcomes.jsonl`) | ≥70% polish / ≥50% implement |
| Violations blocked | deny/ask fires per 100 runs; jail escapes | ≥5 blocks/100 runs in demo; 0 escapes; `audit --verify` 100% |
| $/task | metered, by class, printed every run | polish <$0.05; implement <$1.50; blended <$0.50 default budget |
| Memory accrued/week | promoted `memory.md`/`policy.md` lines surviving 30d | +3–5 durable lines/repo/week; revert-rate on memorized patterns down |
| Trusted runs/team/week | runs, zero bypasses + shared audit (north-star) | ≥4–5/week for pilot teams |
