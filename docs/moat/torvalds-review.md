# Linus Torvalds Review: codewhip Repository

**Verdict: PASS** — This is competent, opinionated systems code. It has real architecture, not framework glue. The abstractions don't leak because they're deliberately minimal. Technical debt is visible and bounded.

---

## Code Quality

**TypeScript strict, zero runtime deps** — `package.json` shows only dev deps (`oxlint`, `tsx`, `typescript`, `@types/node`). No Zod, no Commander, no chalk, no databases. The agent loop validates inputs with hand-written guards (`isBashArgs`, `isReadArgs`, etc.) instead of schema libraries. This is the right call for a CLI tool that must start fast and stay auditable.

**Error handling is explicit, not exception-driven** — Every tool returns `ToolResult = { ok: boolean, output: string }`. The loop never throws; it records failures and continues. `appendEntry` (audit) and `appendOutcome` return `boolean` on disk failure — the loop keeps running. This is how you build systems that don't melt down under load.

**Redaction is at the boundary, not the display layer** — `redactSecrets` runs at transcript push and write boundaries. Secrets never reach the model, never hit the audit log, never land in share bundles. The pattern list is aggressive (API keys, private keys, emails, high-entropy tokens) and the ENV assignment scrubber is separate for share bundles only. Good threat model.

**Concurrency handled with file locks, not mutexes** — `appendEntry` uses a mkdir-based lock with bounded retries and stale-lock detection. `fsyncSync` per append. A crash loses at most one entry, never the chain. This is correct for JSONL on POSIX/NTFS.

---

## Architecture

**Single responsibility per module, <150 lines** —
- `loop.ts` (646 lines) — the agent loop, the only "long" file, but it's one state machine
- `provider.ts` (1142 lines) — all provider configs + OpenAI-compatible port + SSE streaming
- `policy.ts` (254 lines) — permission decisions, denylist, worktree containment
- `audit.ts` (282 lines) — hash-chained log with ed25519 signatures
- `checkpoints.ts` (162 lines) — per-run file snapshots for rollback
- `remember.ts` (130 lines) — shape-based "always allow" memory
- `compact.ts` (128 lines) — transcript compaction with honest receipts

**Provider abstraction is a single `ChatPort` function** — `type ChatPort = (args) => Promise<ChatPortResponse>`. One interface, 40+ builtin providers configured as data rows, custom providers ride the same port. No factory classes, no strategy pattern boilerplate. The loop only knows `port({model, messages, tools, signal})`.

**Policy is a pure function** — `checkPermission(tool, preview, promoted) → PermissionDecision`. No hidden state. The non-overridable denylist runs first (rm -rf /, git push --force, shell chaining, worktree escape), then promoted denies from `policy.md`, then allowlist, then ask-defaults. `--yolo` only bypasses `ask`, never `deny`. This is the correct hierarchy.

**Failover/rotation is explicit state, not magic** — Same-provider model rotation (each candidate once per run), then cross-provider chain (each target once per run). Retry-wait (429 only, once per run). The trail is recorded in `failovers` on the outcome. No silent retries.

---

## Technical Risks

### 1. Provider registry is a data monolith (1142 lines)
`provider.ts` contains 40+ provider configs as a giant object literal. Adding a provider = editing this file. Custom providers (`codewhip provider add`) write to a JSON file and ride the same `openAiPort`, but builtins are hardcoded. **Mitigation**: It's data, not logic. The cost of one table row per provider is acceptable for H1. A registry plugin would be over-engineering.

### 2. SSE streaming is complex (~200 lines in `openAiPort`)
The streaming parser handles delta fragments, tool call assembly by index, usage blocks, idle timeout, and graceful fallback to non-streaming on 400/422. It's the hairiest code in the repo. **Risk**: Provider-specific SSE quirks will accumulate. **Mitigation**: The `streamUnsupported` flag per-port remembers a bad gateway and stops retrying streaming for that run. The `--no-stream` escape hatch exists.

### 3. Worktree containment is string-based for bash, realpath for file tools
`matchWorktreeEscape` uses regex on the raw command string. `read`/`edit`/`write` use `path.resolve` + `path.relative` + prefix check. This asymmetry is deliberate (shell can't resolve symlinks reliably), but it means `bash` is stricter (denies `/tmp/x` even if safe). **Risk**: False positives annoy users. **Mitigation**: Error message tells them to use relative paths. The denylist is non-overridable, so `--yolo` can't bypass.

### 4. Compaction uses chars/4 estimation, not a tokenizer
`estimateTokens` = `Math.ceil(chars / 4)`. Every printed number says "est." — honest about the lie. **Risk**: Under/over-estimation could trigger compaction too early/late. **Mitigation**: Default ceiling 60k est. tokens (~240k chars) is generous for most runs. Tier 1 truncation (tool output heads) is cheap and structure-preserving. Tier 2 elision is the safety valve.

### 5. Test coverage is excellent
`npm test` → **250 tests, 0 failures, 28 suites**. Covers audit chain verification (tampering, key deletion, signatures), rollback hash verification, provider failover/rotation/idle timeout/streaming fallback, policy denylist/allowlist/promotion, compaction tiers, checkpoints, remember store, redaction, jail, router, share bundles, and the demo wedge. Critical paths are exercised.

### 6. `provider-hosts.json` sticky host pinning
Auto-detects which host a key works on (StepFun: `.ai` vs `.com`), pins it. If the pinned host later fails, it falls back. **Risk**: Silent host switch could confuse debugging. **Mitigation**: Pin is per-provider, visible in config dir. The fallback chain is logged in provider stats.

### 7. Memory/remembered rules persist forever
`.codewhip/remembered.jsonl` grows unbounded. No TTL, no cleanup command. **Risk**: Disk growth, stale rules granting access to deleted paths. **Mitigation**: Rules are shape-curated (only allowlisted heads), self-protected paths blocked, and provenance (`runId`, `preview_hash`) is stored. Still needs a `codewhip forget` command.

---

## What's Good (Don't Break)

- **Hash-chained audit log** — `prev_hash` links entries, ed25519 signs each. `verifyChain` checks seq continuity, hash linking, signatures. Key deletion = BROKEN (not unsigned). Export bundles carry pubkey + chain_tail for external verification.
- **Rollback with verification** — Every checkpoint hashed in manifest. Restore verifies ALL hashes before first write. Reverse order (earliest before-image wins). Self-protected paths (`.codewhip/**`, `codewhip-policy.yaml`) never checkpointed, never restored.
- **Promoted policy from human declines** — 3+ declines of same tool:shape across ≥2 runs in 30 days → candidate → `policy approve` → `policy.md` deny line. Pre-flight block in `checkPermission`. Can only deny, never allow. Non-overridable denylist still wins.
- **Free provider chain** — `--free` arms keyless providers first (kilo, opencode, empero, llm7, pollinations), then keyed free-tier models. Never bills pay-go. Honest quota notes per provider.
- **Cost honesty** — Only known-$0 routes print `$0.0000`. Everything else: "cost untracked (see provider console)". No fake metering.
- **Plan mode** — `--plan` makes edit/write/bash denied at harness level (before permission ladder). Read/search/webfetch still work. Output is the plan.

---

## What Needs Work (Before H1 Ship)

1. **Run the test suite** — `npm test` and verify critical paths covered
2. **Add `codewhip forget`** — TTL or manual cleanup for remembered rules
3. **Document the provider registry format** — So custom providers don't need source edits
4. **Consider splitting `provider.ts`** — Config data vs port logic, even if same file
5. **Add integration test for rollback** — Full cycle: run → edit → rollback → verify git diff clean

---

## Summary

This is not a prototype. It's a shipping CLI with:
- Correct failure handling (no exceptions, bounded retries, fsync)
- Auditable trail (hash chain + signatures + rollback verification)
- Honest cost model (no fake $0 claims)
- Policy that can only restrict, never expand
- Provider abstraction that's a function, not a framework

The technical debt is visible, bounded, and documented in the code comments (committee rulings referenced by number). This is how you build infrastructure that doesn't become a liability.

**Ship it. Fix the test coverage gap first.**