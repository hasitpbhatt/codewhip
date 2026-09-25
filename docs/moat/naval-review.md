# Naval Review — CodeWhip (2026-09-12)

**Verdict: The wedge is real. The compounding loop works. Ship the last three P1 items, then freeze H1.**

---

## What's Working (Compounds)

**The free chain + honest meter is the adoption lever.** 4 keyless providers (kilo, opencode, empero, llm7) + 4 free-key providers → `codewhip run "..." --free` gives an intern a metered, audited agent at $0. No other tool does this. OpenCode has 75 providers and an unmetered bill; CodeWhip has 16 where the free ones are verified, ordered, and priced honestly. That is *permissionless leverage* — keep widening it, never gate it.

**Governance is baked, not bolted.** Harness-side policy (0 prompt tokens), non-overridable denylist, shell-chaining deny, worktree containment, ask-default with `--yolo` explicit/logged/bannered, plan mode that even `--yolo` can't bypass. The denylist and chaining-deny win over every remembered rule. This is enforcement-grade, not theater.

**Audit chain is the trust moat.** Hash-chained JSONL, ed25519-signed with the `init` keypair, hashes-only at write (redaction by construction). `--verify` re-walks seq/prev_hash/signatures; `--export` produces a signed content-addressed bundle. Key deletion reads BROKEN, not unsigned. This is the artifact you hand to compliance — and the open-source competitors can't ship it without repudiating their business model.

**Memory is owned, curated, and self-protecting.** "Always allow" stores curated shapes in `.codewhip/remembered.jsonl` with provenance (ts/runId/preview_hash). Only safe heads are memorable; redirects/pipes/chains never are. `.codewhip/**` and `codewhip-policy.yaml` self-protect at the tool *and* memory layer. Policy promotion (3 declines → candidate → approve → `policy.md` deny) turns human judgment into pre-flight blocks. Every run seeds the next run's compounding files: `outcomes.jsonl`, `verdicts.jsonl`, `remembered.jsonl`, `policy.md`. **Empty memory compounds nothing; every run writes to the moat.**

**Checkpoints + rollback converts dread into trust.** Automatic before-image snapshots on every edit/write (sha256 manifest, JSONL, self-protecting). `codewhip rollback <prefix>` verifies every hash before touching a byte, restores newest-to-oldest (earliest wins), removes created files, lands on the audit trail. The intern at 2am has an undo. This is the single feature that makes "delegatability" real.

**Compaction is designed, not defaulted.** Two-tier prune (truncate old tool outputs → elide whole exchanges as blocks), chars/4 estimate printed as "est.", system prompt + original task + newest exchanges never touched. Honest receipt: `compacted: N tool outputs truncated, M exchanges elided (est. X → Y tokens)`. Sessions survive their own context window.

**Tests, lint, typecheck: 250 passing, 0 warnings, 0 errors.** Solo-builder velocity preserved: small modules, explicit types, no `any` without justification, <150 lines per tool, JSON I/O, timeout-bounded, never throws the loop.

---

## What's Fragile (Fix or Accept)

**Polish gate is OPEN — no priced proof yet.** The router mechanism ships (implement→nvidia, polish→sensenova, private→local), but the <$0.05 launch gate needs a real priced polish run with receipts. Sensenova/Alibaba/Mistral pricing must be derived from `PROVIDERS`, never fiction-priced. This is the *only* blocker to public launch — SOUL §5 ruling holds.

**Provider health is thin.** 16 builtins, but only NVIDIA free tier is known-$0. Groq/Cerebras/OpenRouter/Gemini/Zai have free keys but quotas are unpublished or time-limited (Zai promo, Empero in maintenance). The `--free` chain is honest about this — every listing note is evidence-dated — but the "free chain" promise only holds while endpoints stay live. Acceptable for H1; widen keyless-first as new endpoints appear (ruling 4).

**Plan mode & checkpoints are new.** Shipped per committee ruling 1 & 2 (2026-09-11/12). Edge cases: rollback on symlinks, rollback across filesystem boundaries, compaction interacting with remembered-rules. Tests pass (250/250) but real-world friction will surface bugs. Treat as "boring engineering" — fix fast, don't abstract.

**REPL is preview.** `codewhip run` with no prompt on TTY drops into REPL, but slash commands (`/model`, `/free`) and free-chain visibility in-run are not built. Low priority — the headless run is the product.

**Windows path edge cases.** Bash runs PowerShell on win32; denylist covers `remove-item -recurse -force`, `rd /s`, `del /s /f`, `format`. Worktree escape regex is string-based (not realpath) — deliberately strict. May over-deny legitimate absolute paths (`/tmp/x`). Acceptable friction for H1; sandbox profiles (H2) solve it properly.

---

## What's Noise (Cut or Defer)

**Streaming, subagents, MCP.** Kill list holds (SOUL §4.5, roadmap kill list). Smooth scrolling of a wrong answer is noise. Breadth theater is the enemy. No streaming until compaction is boring. No subagents until the loop is right. No MCP catalog ever in H1.

**Desktop/TUI/IDE.** Terminal (SSH-able, CI-runnable, scriptable) only until trusted runs compound. The product is *one sentence*: the agent you can hand to an intern at 2am because everything is checked, replayable, and undoable.

**Graph memory, vector DB, SQLite.** JSONL + flat markdown only until >500 outcomes + weekly multi-hop queries prove the pain (ruling 7, roadmap). Mem0/Zep/Letta evaluated then, never replacing flat files.

**SSO, enterprise bundle, compliance deck.** H2 only. Policy-as-code + audit chain + sandbox is the product; SSO is a checkbox.

**75-provider matrix.** 3 providers wired in H1 (NVIDIA, Mistral, Sensenova). Custom OpenAI-compatible registration (`codewhip provider add`) is the escape hatch. Adding a provider is one table row, nothing else.

**Public launch, partnerships, content flywheel.** No launch until polish <$0.05 with receipts. Credibility with developers is spent exactly once (SOUL §5).

---

## What Compounds (The Moat)

| Artifact | Compounds By | Moat Layer |
|---|---|---|
| `outcomes.jsonl` | Every run (usage, allow/deny, failovers, verdicts) | Execution |
| `verdicts.jsonl` | Human judgment per run (accepted/edited/reverted/rejected) | Memory |
| `remembered.jsonl` | Curated shapes + provenance (ts/runId/preview_hash) | Memory |
| `policy.md` | Promoted denies from 3+ declines (pre-flight blocks) | Governance |
| `.codewhip/audit.log` | Hash-chained, signed, redacts-by-construction | Governance |
| `.codewhip/checkpoints/` | Per-run before-images, sha256 manifest, rollback trail | Trust |

**Nothing OpenCode ships compounds.** Their state is a config file. CodeWhip's state is the scar tissue you can't rebuy.

---

## Final Orders

1. **Close the polish gate.** Price sensenova/alibaba/mistral from `PROVIDERS`, run a real polish task, print the <$0.05 receipt. Then launch gate = CLOSED.
2. **Ship the remaining P1 hygiene (roadmap items 4–8):** pasteable share (`--share --print`), REPL slash commands, pack honesty, reporting honesty, drift/hygiene. No scope creep.
3. **Freeze H1.** 7 rulings, no ties. Kill list is final — needs evidence to reopen.
4. **Position on the axis that matters.** README comparison table: metered, audited, undoable, $0-capable vs capability-breadth. No "incumbent killer" hype. SOUL voice.

The wedge is built. The compounding loop works. The trust artifacts are exportable proof. **Ship the last three items, prove the meter, then the product speaks for itself.**

---

*Reviewed against: SOUL.md, docs/moat/00-convergence.md, docs/roadmap.md, docs/moat/07-committee.md, src/ (65 modules, 250 tests passing, lint/typecheck clean).*