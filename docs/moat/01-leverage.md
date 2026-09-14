# 01 — Leverage: the minimal loop that earns while we sleep

Thesis: CodeWhip's only moat is code that writes code cheaper than anyone else.
Everything that needs headcount, meetings, or manual review to sustain is not a moat. Kill it.

Ground truth: `codewhip@0.1.0`, Node>=18, TS ESM, `run` prints "agent session not implemented yet". No loop, no tools, no router. That is the entire backlog for v1.

## Minimal loop spec

```
user prompt -> build messages+tools -> stream LLM -> tool call?
  yes -> permission check (allow/ask/deny) -> exec -> append result -> repeat
  no  -> print final answer -> exit
Interrupt (Ctrl-C): cancel stream + kill running tool, keep transcript.
--max-steps N (default 25): hard stop, print partial + cost. No infinite loops. Ever.
```

Concrete rules:
1. Single async `agentLoop()` in TS, no server/worker threads. Headless `codewhip run "fix X"` + stdin REPL first. TUI comes after the loop works, not before.
2. Provider interface = Vercel AI SDK `LanguageModelV2` (`streamText` + tools). One interface, 25+ models free via models.dev. No custom SDK per vendor.
3. Messages are the state. In-memory array, append-only. Persist as JSONL transcript (one file per session). No DB in v1.
4. Tool calls are JSON, validated by Zod, timeout 60s default. Failure = tool-result string fed back to model, never a crash.
5. Cost meter wraps every step: tokens in/out x model price, running total printed on exit. If meter is missing, the loop ships nothing.

Parity bar: OpenCode's TUI/server/event-bus/SQLite is v3, not v1. v1 parity = Claude Code's core: multi-step edits with interrupt and step cap. Nothing more.

## v1 tool set + deferred tools

Ship 5 tools. Each <150 lines:
- `read` (file, offset/limit) — no `cat` dumps into context.
- `glob` + `grep` (merge into one `search`) — exploration without reading the repo whole.
- `edit` (exact-match replace + 2 fallbacks: whitespace-insensitive, fuzzy). Not OpenCode's 9 strategies — 3 is enough to fix 90% of misses.
- `bash` (deny-by-default for `rm -rf`, `sudo`, network exfil; ask otherwise; allow `ls`, `git status`, test runners).

Defer explicitly: `lsp` diagnostics, MCP client, `webfetch`/`websearch`, `task`/subagents, `batch` parallel, `question`/`skill`, desktop/IDE/TUI widgets, undo/redo. Each deferred tool 10x's context or support load. Earn the right with users first.

## Router + cost model (with concrete $/task reasoning)

Three task classes, routed by a keyword classifier, overridable by `--provider`/`--model`:
- **implement** (multi-file refactor, hard bug): frontier. Sonnet 5 ($3 in / $15 out, intro $2/$10 thru Aug-2026) default. Opus ($5/$25) only on retry or `--effort max`.
- **polish** (tests, docs, lint, simple edits): cheap. DeepSeek V4-Flash ($0.14 in / $0.28 out, cache-hit $0.0028) or Qwen 3.7 Flash ($0.03/$0.13). Good enough, 10-40x cheaper.
- **private** (prompt matches secret keywords): **routes to a loopback provider you registered** (Ollama/vLLM/LM Studio) — $0 marginal, never leaves the machine. With none registered it refuses, so the only way a secret-bearing prompt reaches a remote model is an explicit `--provider`, which is informed consent, logged on the receipt.

$/task math (modeled session: 1.5M input @90% cache-hit + 40k output):
- Sonnet @ $3/$15: 1.35M x $0.30 + 150k x $3 + 40k x $15 = ~$1.46/task.
- Opus @ $5/$25: ~$0.68 + $0.75 + $1.00 = ~$2.42/task.
- DeepSeek Flash: 1.35M x $0.0028 + 150k x $0.14 + 40k x $0.28 = ~$0.004 + $0.021 + $0.011 = **~$0.04/task. 35x cheaper than Sonnet.**
- Qwen 3.7 Flash: even lower, ~$0.01/task for polish work.

Contract: `--budget $/task` (default $0.50). Preflight: estimate = class rate x max-steps cap. Mid-run: if projected > budget, auto-downgrade implement->polish or stop and ask. Post-run: print `tokens / model mix / $`. A user doing 10 tasks/day pays ~$0.40/day routed vs ~$15-25/day all-Opus. That spread IS the business model.

## Kill list (what NOT to build and why)

1. No custom model hosting or fine-tunes. Pure labor leverage, zero compounding. Rent models.dev.
2. No desktop app (Tauri/Electron), IDE extension, or TUI theming. Each doubles support surface for zero extra tasks completed.
3. No MCP server hosting, plugin marketplace, or skills library. Distribution theater before the loop works.
4. No SQLite/Drizzle/event-bus in v1. JSONL transcripts + prompt cache cover 90%. DB is a scaling reward, not a starting requirement.
5. No SSO/audit-log/policy-DSL enterprise bundle. Claude Code already sells that to enterprises. We win on $/task, not checkboxes.
6. No subscription that hides meter. Metered routing is the moat — obscuring it destroys the price signal users pay for.
7. No eval team, no prompt-engineering guild, no "AI consultancy". If it needs humans per task, it is anti-leverage.

## Open disagreements

**naval-memory:** you will argue memory-first — SQLite + event log + semantic recall from day one because "moat = state that compounds." My objection: empty memory compounds nothing. A DB with zero successful tasks is a liability that slows the only thing that matters: shipping the loop that completes task #1. Transcript JSONL is sufficient state for v1; prompt-cache (10x input discount) already IS memory. Build recall after 1,000 paid tasks prove what is worth remembering, not before. Do not block v1 on schema design.

**naval-governor:** you will argue governance-first — permission DSL, audit trails, enterprise policy as the wedge. My objection: governance without volume is a tax nobody pays. Claude Code already has permission gates + enterprise trust + leaked harness anyone can copy; out-governing Anthropic with 0 engineers is fantasy. Minimal allow/ask/deny on `bash`+`edit` stops real damage. Everything else (SSO, signed receipts, redaction pipelines) is labor-leverage theater until routed $/task forces adoption. Users forgive missing audit logs; they never forgive $2.42 for a typo fix.

**naval-scout:** you will argue GTM-first — partnerships, launch content, marketplace distribution before the engine is 10x cheaper. My objection: distribution is rented leverage; routing is owned leverage. Selling a CLI stub that prints "not implemented yet" burns the one asset we cannot rebuy: credibility with developers. No launch, no partnerships, no content flywheel until `run` demonstrably does polish tasks at <$0.05 with meter receipts. When $/task is 30x better, developers ARE the distribution. Until then, marketing is lying with extra steps.
