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

H1 core shipped. `codewhip run` is live (loop, tools, policy jail, audit chain, outcomes+remembered, init/run/--share, 3-class router mechanism, CI + packs, policy promotion). Launch gate is OPEN: polish <$0.05 proof is pending a real priced polish run with receipts.

## Next (post-H1 polish)

Ordered from `docs/moat/06-post-h1-verdict.md` P1 items 3–8. All are implementation hygiene, no scope creep.

- [ ] **Pasteable artifact** — `run --share --print` prints a Markdown receipt block anchored to the audit chain.
- [ ] **Passable gate** — price `sensenova/alibaba/mistral` or re-route polish to a priced <$0.05 route; derive price key from `PROVIDERS` and never fiction-price.
- [ ] **Truth to model** — reword tool specs so the model does not believe chaining is permitted; fix the search comment that incorrectly claims `read` skips secrets.
- [ ] **Pack honesty** — make starter pack denies fire on both `edit` and `write`, normalize shapes, or drop phantom claims.
- [ ] **Reporting honesty** — decision buckets (allow/deny/remembered/policy), untracked spend handling, `--last`/`--replay` parity, empty export failure, `missing===2` clarity.
- [ ] **Drift + hygiene** — settle tool count wording, single-shot vs REPL labeling, receipt legend for $ tracking, gate OPEN label, dead branches, REPL receipt, remove vacuous assertions.

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
  (kilo/opencode/empero/llm7) — plus `codewhip free` and the `--free` chain).
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
   with receipts; no unbounded memory without redaction + policy scope.

## Metrics (bars — readable via `codewhip metrics`)

| Metric | Definition | H1 bar |
|---|---|---|
| Task success % | multi-step edit completes + tests pass, no rescue (from `outcomes.jsonl`) | ≥70% polish / ≥50% implement |
| Violations blocked | deny/ask fires per 100 runs; jail escapes | ≥5 blocks/100 runs in demo; 0 escapes; `audit --verify` 100% |
| $/task | metered, by class, printed every run | polish <$0.05; implement <$1.50; blended <$0.50 default budget |
| Memory accrued/week | promoted `memory.md`/`policy.md` lines surviving 30d | +3–5 durable lines/repo/week; revert-rate on memorized patterns down |
| Trusted runs/team/week | runs, zero bypasses + shared audit (north-star) | ≥4–5/week for pilot teams |
