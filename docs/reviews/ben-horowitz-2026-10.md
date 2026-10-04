# Ben Horowitz Review — CodeWhip (2026-10-04)

Synthesis across the five personas, verified against HEAD `8a52994`
(`removal-of-auto-routing-aggregator-free-chain`).

## One-Line Verdict

CodeWhip owns delegation-grade trust — signed audit, harness-side policy,
memory that survives a model switch — but still ships friction a team lead
cannot hand to an intern at 2am, and the launch pillar the personas
leaned on hardest (the keyless free chain) is no longer in the tree.

## What Is Real (the wedge holds)

- **Signed audit chain.** `.codewhip/audit.log` is hash-chained with
  `prev_hash` and ed25519-signed from `codewhip init`. Pre-key unsigned
  entries are expected history, not `BROKEN` — `trust` and `audit --verify`
  share one interpretation (`interpretVerification`), so two verifiers can
  never disagree.
- **Policy jail.** Non-overridable denylist outranks `--yolo`; ask is the
  default and `--yolo` is explicit, logged, bannered. Promoted `policy.md`
  denies compile from 3+ human declines across 2+ runs.
- **Memory that is inspectable and revocable.** `codewhip remember list` /
  `codewhip remember forget "<tool:shape>"` exist, store provenance
  (`ts/runId/preview_hash`), and self-protect `.codewhip/**`.
- **Pasteable receipt.** `run --share --print` renders a Markdown block
  anchored to the audit chain via `renderShareMarkdown` (`src/share.ts`).
- **Single-command trust certificate.** `codewhip trust [--json] [--verbose]`
  reports chain, policy, polish gate, memory, keys, and prints contextual
  next steps. It gates on evidence, not aspiration, and it never farms grants
  by telling you to press `a`.

## What Leaks (the wedge is not yet delegable)

| # | Gap | Evidence at HEAD | Raised by |
|---|-----|------------------|-----------|
| 1 | Keyless free chain deleted | `provider-registry.ts`: `BuiltinProviderId = never`, `PROVIDERS: Record<string, never> = {}`; commit `db32ab6` | SOUL §5, Jobs, Naval, Li Lu |
| 2 | `--yolo` banner omits promoted denies | `src/index.ts:1107` names denylist, ask ladder, worktree wall, signed audit — never the `policy.md` promote layer | Norman |
| 3 | Audit chain integrity not printed on run completion | success path prints checkpoints/compact/share but no chain status; only the `auditDropped` failure path speaks | Norman, Jobs |
| 4 | Provider health is post-mortem only | `src/index.ts:1550` fires the health hint only when `ph.failed > 0` | Norman |
| 5 | `policy` is a ratchet | only `candidates` / `approve` / `list` (`src/index.ts:2333`) — no `revoke`, no `edit` | Norman |
| 6 | `trust` reads as a debug log | flat vertical dump, verdict at the bottom, no `--ci` exit code | Jobs v2 |
| 7 | No `doctor`, `compact-preview`, `policy preview` | absent from `src/` | Norman P2 |

## Convergence — the Five Agree

1. **Trust surface is the handoff.** `trust` exists and its logic is honest;
   what is missing is the *experience*: visual hierarchy, chain status on
   every run, `--json` for CI.
2. **The $0 on-ramp is gone.** Four personas' launch reasoning assumed
   keyless providers. With `PROVIDERS = {}`, first run needs a
   user-registered provider, so `trust` reports `broken: keys` on a fresh
   repo — the documented 4-command / 2-minute path no longer exists.
3. **Policy layers must be inspectable.** The `--yolo` banner, `policy
   revoke`, and `policy preview` are three expressions of one need: show the
   user every layer that can refuse them.
4. **Compounding is invisible.** Audit integrity, memory accrual, and provider
   health all exist but print only on demand. SOUL §6 says every run prints
   its receipts; the trust receipts are the ones still missing.

## Money Insight

Price the **artifact, not the agent**. Execution is commoditized; the
defensible asset is a signed audit bundle plus per-repo scar tissue
(`policy.md`, `remembered.jsonl`, verdicts). The four candidate models —
pack-registry tiers, metered CI overages, trust-certificate SaaS, audit
export for SOC2 — differ in cost of serving, but only one is consistent with
the kill list (no subscription hiding the meter): **audit bundle export for
compliance evidence**, with the CLI and the $0 floor staying free.

## Recommendation

Close the trust *experience* before any monetization work: print chain
integrity on run completion, name every bypassed layer in the `--yolo`
banner, warn on provider health pre-flight, and give policy living-doc verbs
(`revoke`, `preview`). Separately, decide the free-chain question in the
open — restoring a $0 on-ramp is a product ruling, not a cleanup task, and
it needs a recorded decision rather than a silent commit.

— *Ben Horowitz persona, synthesizing Norman / Jobs / Torvalds / Naval / Li Lu*
