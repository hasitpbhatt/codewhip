# 05 — H1 Gap Audit (four-lens status check)

Status as of `e02c971` (post principal-review fixes, 79/79 tests). The four Naval
roles re-audited H1 against `docs/roadmap.md` + `docs/moat/00-convergence.md`,
checking code, not claims. Verdict per lens: leverage, governor, memory, scout.

## Leverage lens (loop / tools / provider / CLI)

- `agentLoop()` **DONE** — steps, permission check, exec, append, cost; token
  budget mid-run with partial receipt; Ctrl-C wired through AbortController
  into `withTimeout` → bash `execFile signal`. Caveat: non-streaming
  (message-level only), and the max-steps stop is silent (receipt only).
- 5 tools **DONE** real + tested (read, search, write, edit, bash); git is a
  bash allowlist, not a tool. `read` and `bash` have no direct test file.
- Provider matrix **DONE** — nvidia, mistral, sensenova, alibaba in one
  registry table; `--model`/`--provider`/`--models` rotation + failover;
  meter prints every run (cost known only for nvidia free tier).
- `init` + `run` **DONE** (headless + REPL, CI-safe ask⇒deny).
- `--share` **NOT-STARTED** — redactor primitive exists (`src/redact.ts`),
  wired at push boundary, but no share pipeline, no command.

## Governor lens (policy / audit / jail)

- Policy jail **DONE** — fail-closed, realpath jail, denylist + token-level
  force-push, chaining-deny throughout. Gap: `codewhip-policy.yaml` written by
  `init` is never parsed (decorative); jail covers file tools, bash is
  ask-gated not path-jailed; no symlink-escape test.
- **Audit chain NOT-STARTED** — no `audit.log` writer, no hash-chain schema,
  no signature use of the `init` ed25519 key. `audit --last` reads
  `outcomes.jsonl` (wrong file); `audit --verify` prints "not implemented
  yet"; `--export`/`--replay` absent. This is the single unfilled P0 item —
  the gate before P1.
- Redaction at write **PARTIAL** — outcomes path real and redact-before-hash;
  the audit writer (once it exists) must redact commands/hashes the same way.

## Memory lens (outcomes / remembered / redaction)

- `outcomes.jsonl` **DONE** every run (v:1, per-tool deny/allow + ruleId,
  usageByModel[]/failovers[], redacted at write). Gap: no loop-level test
  asserts the file is actually written.
- `remembered.jsonl` **DONE** — append-only, provenance, curated shapes,
  self-protecting; auto-allow at 0 prompt tokens.
- Redaction **DONE** pattern-based. Gap: no `redact.test.ts` unit file.
- `memory.md`/`notes/`/inject 400 tokens, `memory distill/approve`
  **NOT-STARTED** (roadmap honestly labels "Future").

## Scout lens (GTM / CLI / docs / metrics)

- `init`/`auth status`/`models` **DONE**; all four providers surfaced.
- Kill list **COMPLIANT** — zero H2 creep in code; only drift: 4 providers
  vs ruling-7's 3 (doc-vs-code mismatch).
- README **DRIFT** — says 57 tests (real: 79), 3 providers (real: 4),
  "nvidia keyless" (false), "six tools" (real: five + git allowlist).
- Metrics **PARTIAL** — violations + per-model usage measurable now; $/task
  only for nvidia; task-success `verdict` always null (no signal collected);
  jail-escape detection needs the audit chain.

## Decisions for the build order (newest ruling)

- 2026-09-10 — **Audit chain is the next P0 unit.** Ship `.codewhip/audit.log`
  hash-chained JSONL (`v:1`, `seq/ts/actor/tool/args_hash/result_hash/prev_hash/policy/sig`),
  ed25519-signed with the `init` keypair (`sig:null` when unsigned), redaction
  applied before hashing (same rule as outcomes). CLI: `audit --verify`
  (chain + signature), `audit --last N`, `audit --replay N`, `audit --export`
  (content-addressed signed bundle). This unblocks `--share`, CI audit links,
  and jail-escape measurement.
- 2026-09-10 — README corrected to match shipped reality (79 tests, five
  tools + git allowlist, four providers, keyless claim removed).