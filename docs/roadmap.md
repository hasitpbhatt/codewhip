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
- [ ] **REPL slash commands** — `/model`, `/free`; free-chain visibility in-run.
- [x] **Pasteable artifact** — `run --share --print` prints a Markdown receipt block anchored to the audit chain. *(shipped 2026-09-17: `renderShareMarkdown` + `--print` flag, audit_tail + bundle hash + sig line)*
- [x] **Passable gate** — polish re-routed to priced $0 kilo hop; real run `28589c84` passed at $0.0000 with verdict `accepted`. *(shipped 2026-09-17 — supersedes the WAIVED ruling the same day)*
- [ ] **Truth to model** — reword tool specs so the model does not believe chaining is permitted; fix the search comment that incorrectly claims `read` skips secrets. *(Repeat-call guard shipped 2026-09-12: identical idempotent calls are memoized in-run, cleared on edit/write, recorded as `allow:loop:repeat-call`.)*
- [x] **Pack honesty** — starter-pack `.env*` denies fire on both `edit` and `write` (`deny write:` twins, pinned by a content-vs-enforcement test). *(shipped 2026-09-17)*
- [ ] **Reporting honesty** — decision buckets (allow/deny/remembered/policy), untracked spend handling, `--last`/`--replay` parity, empty export failure, `missing===2` clarity.
- [ ] **Drift + hygiene** — settle tool count wording, single-shot vs REPL labeling, receipt legend for $ tracking, polish-gate label wording, dead branches, REPL receipt, remove vacuous assertions.
- [x] **Multi-turn sessions** — `run --continue [prefix]` resumes the newest (bare) or one (≥4-char unique prefix) saved transcript and persists the post-compaction transcript on every loop exit path; `codewhip sessions` lists newest-first with redacted previews; REPL threads one in-memory transcript and saves once on `.exit` *(shipped 2026-09-14 — sessions v1, opt-in, redacted, system-stripped)*

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
