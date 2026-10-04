# Unified Fix Plan — 2026-10-04

Source of synthesis: `docs/reviews/ben-horowitz-2026-10.md` plus the
per-persona reviews in `docs/moat/`. Verified against HEAD `8a52994`, not
against the pasted planning text — several items that text listed as
"already complete" are complete, and two are contradicted by the tree.

## Status of the pasted plan's 10 P0s

| # | Pasted item | Verified state at HEAD | Verdict |
|---|-------------|--------------------------|---------|
| 1 | Meter proof (polish gate PASS) | `trust` evaluates the last polish run's real cost; `PROVIDERS = {}` so no route can be registered without the user | **blocked on product decision** |
| 2 | `codewhip trust` | Exists (`src/index.ts:2604`), `--json`/`--verbose`, contextual next steps | **done, presentation debt** |
| 3 | Keyless first run (free chain) | **Contradicted** — `db32ab6` deleted free chain and all builtins | **open, needs ruling** |
| 4 | Pasteable share | `--share --print` → `renderShareMarkdown` | **done** |
| 5 | `--yolo` honesty banner | `src/index.ts:1107` omits the promoted-`policy.md` layer | **open** |
| 6 | `remember list` / `forget` | Exists (`src/index.ts:2553`) | **done** |
| 7 | Provider health pre-flight | Post-mortem only (`src/index.ts:1550`) | **open** |
| 8 | Policy `revoke` / `edit` | Missing — only `candidates`/`approve`/`list` | **open** |
| 9 | Audit chain visibility on every run | Missing on the success path | **open** |
| 10 | History sanitization (force-push) | 7 commits carry `Co-authored-by:` trailers on `main` | **blocked — needs user approval, banned by AGENTS.md** |

## P0 — blocking the delegatability claim

### T1. Print audit chain integrity on run completion
- **Why:** the trust anchor is invisible unless you ask for it.
- **Change:** after `printMixReceipt` in `cmdRun`, print a one-line chain
  status using the same `interpretVerification` the `trust` command uses, so
  no second verifier exists.
- **Acceptance:** a successful run prints `audit: chain INTACT (…)`; a
  tampered chain prints `BROKEN` and sets a nonzero exit.
- **Size:** <40 lines, no new dep.

### T2. `--yolo` banner names every layer it does not bypass
- **Why:** the flag promises recklessness; the harness delivers constrained
  recklessness. The omitted layer is the one users hit first: promoted
  `policy.md` denies.
- **Change:** rewrite `src/index.ts:1107` to enumerate the denylist, promoted
  `policy.md` denies, remembered rules, worktree wall, and signed audit.
- **Acceptance:** banner text contains `policy.md`; a promoted deny still
  refuses under `--yolo` and the message points at the layer.

### T3. `policy revoke` / `policy edit`
- **Why:** policy is write-only. Approving a deny by mistake has no in-product
  remedy, so users hand-edit files the harness owns.
- **Change:** `codewhip policy revoke "<tool:shape>"` and
  `codewhip policy edit` (open the promoted list for editing) in
  `policy-store.ts`, audited like `remember forget`.
- **Acceptance:** revoke removes the line from `policy.md`, the next run stops
  pre-flight refusing, and the revocation lands on the audit trail.

### T4. Provider health pre-flight warning
- **Why:** the user learns a provider is flaky after wasting a run.
- **Change:** before the loop starts, if the selected provider has a recorded
  success rate below 90% over 50+ calls, print a warning with the `stats`
  pointer. Reuse `readProviderCalls` / `summarizeCalls`.
- **Acceptance:** a provider seeded at 87% warns before the first call; a
  healthy provider stays silent.

## P1 — next 30 days

- **T5. `trust` as a scannable certificate.** Verdict first, one line per
  gate, `--ci` exit code for pipeline use. Logic stays as-is; this is output
  shape only.
- **T6. `policy preview "<tool:shape>"`.** Show the effective decision and
  *which* layer produced it — the single affordance Norman asked for.
- **T7. `compact-preview`.** Current estimate vs ceiling and what would drop,
  before a compaction fires unannounced.
- **T8. Free-chain ruling.** Record the decision either way in
  `docs/moat/00-convergence.md`. Restoring a $0 on-ramp is a product ruling
  with a maintenance cost (endpoint rot), not a cleanup task.

## P2 — after the pilot

- `doctor` (a `trust` for keys, chains, and provider reachability).
- Unify or document the bash-string vs file-realpath containment asymmetry.
- Audit bundle export for SOC2 evidence (the monetization candidate).

## Verification gate per ticket

`npm run lint && npm run typecheck && npm test && npm run build` green, plus
a named acceptance test per ticket.

## Explicitly out of scope

- **Phase 0 history rewrite.** Force-pushing rewritten history is a
  destructive, shared-branch operation. It requires explicit approval and is
  listed under the safety rules this repo's `AGENTS.md` forbids. It is not a
  code task and is not scheduled here. Separately: `--reset-author` changes
  who authored each commit, which is authorship history, not formatting — so
  it needs a decision, not a script.
- Restoring the free chain (T8) without a recorded ruling.
