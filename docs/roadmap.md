# CodeWhip Roadmap — the consolidated bet

Source of truth for build order. Converged from the five Naval agents' debate
(`docs/moat/00-convergence.md` — 7 rulings, no ties). Soul and principles:
`SOUL.md`. Per-agent findings: `docs/moat/01–04`.

**Wedge:** CodeWhip is the terminal agent a team lead can let an intern run on
prod-adjacent code at 2am — policy-checked, memory-scoped, replayable from a
redacted audit link, metered to <$0.05 on polish work.

**Horizons:** H1 = OpenCode parity in the terminal, with enforcement-grade
governance. H2 = credible open alternative to Claude Code's closed trust.

## H1 backlog (ordered, solo-builder sized)

### P0 — the loop that earns

- [ ] **P0 `agentLoop()`** — `messages+tools → stream → permission check → exec
  → append → repeat`; Ctrl-C cancels stream + kills tool, keeps transcript;
  `--max-steps 25` hard stop with partial result + cost. Single async function,
  no server/worker threads. Headless `run "…"` + stdin REPL first.
- [ ] **P0 five tools (<150 lines each)** — `read` (offset/limit), `search`
  (glob+grep merged), `edit` (exact + whitespace-insensitive + fuzzy;
  3 strategies, not 9), `bash` (deny-by-default), git via bash allowlist
  (`status`, `diff`).
- [ ] **P0 provider interface** — one `LanguageModelV2`-style interface
  (`streamText` + tools); wire Anthropic + OpenAI + Ollama only; `--model`
  override; always-on cost meter (`tokens / model mix / $`); `--budget $0.50`
  with preflight estimate + mid-run downgrade-or-stop.
- [ ] **P0 policy jail** — `codewhip-policy.yaml`, LAST-match-wins,
  fail-closed defaults (`read:allow edit:ask shell:ask external:deny`);
  v1 path jail (realpath, no symlink escape); non-overridable denylist
  (`rm -rf /`, `push --force`, exfil patterns). Ask-default; `--yolo`
  explicit, logged, bannered; CI `ask ⇒ deny` unless signed `--approve-all`.
- [ ] **P0 audit chain** — `.codewhip/audit.log`, append-only hash-chained
  JSONL (`seq/ts/actor/tool/args_hash/result_hash/prev_hash/policy/sig`);
  secret redaction at write; `audit --verify/--last/--replay`; `--export`
  signed bundle (auditor artifact).
- [ ] **P0 memory sidecar** — `.codewhip/outcomes.jsonl` (verdict
  `accepted|edited|reverted|rejected` + tests + model + diff hash);
  `memory.md` (<100 lines: do / don't / gotchas, evidence-linked);
  `notes/<path>.md` (≤20 lines each); inject ~400 tokens/run;
  `memory distill` (≤3 proposals from last 50 outcomes) + `memory approve`.
  Memory writes are audited tool calls — no provenance, no ship.
- [ ] **P0 entry points** — `codewhip init` (30s: `AGENTS.md` + policy +
  local ed25519 keygen); `codewhip run` (headless + REPL); `--share`
  redacted link (env values, keys, emails stripped via allowlist regex).

### P1 — trust that spreads

- [ ] **P1 router proof** — 3 classes (implement→frontier Sonnet-class,
  polish→cheap Flash-class, private→local); 5-line classifier + override;
  **gate: proven <$0.05 polish receipt before any public launch.**
- [ ] **P1 CI + packs** — `codewhip-action@v1` (same policy in CI, audit link
  posts to PR); one starter team pack + `pull team/<pack>`.
- [ ] **P1 policy promotion** — 3 consistent rejections → candidate in
  `policy.md` → one-command approve → compiles to pre-flight grep/lint block
  (generation refused before tokens burn, with rule pointer).

## H2 backlog (ordered)

- [ ] Sandbox profiles `local|e2b|firecracker` behind the frozen v1
  policy/audit schema; network isolation.
- [ ] Pack registry: versioned team packs, fork/override ranking, private
  hosting + SSO/retention (paid tiers: free → $20 pro → $40 team).
- [ ] Graph memory **only on proven pain** (>500 outcomes + weekly multi-hop
  queries): edges derived from `outcomes.jsonl`; Mem0/Zep/Letta evaluated
  then; flat files never replaced.
- [ ] Full provider matrix + auto-fallback + latency optimization; local-model
  parity path.
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

## Metrics (bars)

| Metric | Definition | H1 bar |
|---|---|---|
| Task success % | multi-step edit completes + tests pass, no rescue (from `outcomes.jsonl`) | ≥70% polish / ≥50% implement |
| Violations blocked | deny/ask fires per 100 runs; jail escapes | ≥5 blocks/100 runs in demo; 0 escapes; `audit --verify` 100% |
| $/task | metered, by class, printed every run | polish <$0.05; implement <$1.50; blended <$0.50 default budget |
| Memory accrued/week | promoted `memory.md`/`policy.md` lines surviving 30d | +3–5 durable lines/repo/week; revert-rate on memorized patterns down |
| Trusted runs/team/week | runs, zero bypasses + shared audit (north-star) | ≥4–5/week for pilot teams |

## Weekly sequencing (solo builder)

- **Week 1:** loop + read/search/bash/edit + permission stub.
- **Week 2:** provider interface + 3 providers + meter + budget.
- **Week 3:** policy jail + denylist + audit chain + `init`.
- **Week 4:** outcomes/memory sidecar + `--share` redactor.
- **Week 5:** 3-class router + <$0.05 polish proof.
- **Week 6:** GitHub Action + starter pack + policy promotion. Then H2.
