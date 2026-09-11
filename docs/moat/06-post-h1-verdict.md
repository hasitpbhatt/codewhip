# 06 — Post-H1 five-lens verdict (133/133, 2026-09-11)

All five Naval agents audited H1 at `f313fd1` against code, not claims.
SHIP VERDICT: **NOT SHIPPABLE to a team lead yet** — mechanism real, 12 P0
holes break the trust story. Offline scripted demo only until P0 is green.

(Note: the synthesizer briefly rewrote `00-convergence.md` in place; that
was reverted — the frozen record stands. This file is the verdict's home.)

## Agreed — confirmed by all four lenses

- Redirect/chain over-permit is real: `CHAIN_RX` omits `>`,
  `UNMEMORABLE_RX` omits backticks/`<`, remembered `echo *` re-allows redirects.
- Edit/write remembered match is dead (`edit:<path>` vs bare-path compare);
  edit promotions write `edit:edit:<path>` and never fire.
- `edit` lacks self-protection; `read` serves `.env`/key material;
  share `error` and trace previews stored raw; redactor misses
  mistral/sensenova/alibaba formats + lowercase env.
- Tool specs lie to the model (chaining "works"); search comment claims
  `read` skips secrets (only search does).
- Polish gate structurally unreachable (polish auto-routes to untracked
  sensenova; price key is a detached literal).
- Private/missing-key refusals write zero trail; share "link" is a
  gitignored local path, not forwardable.
- Promotion learns almost nothing (4/5 deny paths + all allows persist no
  shape); `memory.md`/distill correctly deferred behind the verdict signal.

## Debate rulings (no ties)

- **D1 — Unsupervised-ready?** Governor NOT-shippable vs Leverage
  supervised-TTY-ok vs Scout offline-only. **Ruling: Governor+Scout win — no
  pilot, not even supervised, until P0 is green.** *Cost-of-wrong:* one
  bypass/key-overwrite/exfil in a pilot kills trust permanently; delay costs
  weeks, recoverable.
- **D2 — Next order: verdict-first vs demo-first.** **Ruling: Memory wins —
  verdict unlocks honest task-success and correct promotion; demoing a
  flywheel that only learns safe commands misleads.** *Cost-of-wrong:*
  demo-first burns pilot credibility; verdict-first delays demo ~a day.
- **D3 — Private-refusal-without-trace: bug or correct?** **Ruling: Scout
  wins, it is a bug** — invisible deny violates audit-senior and breaks the
  violations-blocked metric. Log as deny with `prompt_hash`, zero content.
- **D4 — Promotion sound vs poisonable.** **Ruling: Memory wins — one
  session can spam 3 declines into a candidate; zero-evidence approve allows
  injection; hand-edited `rm *` is honored.** Harden before any team use.
- **D5 — Audit tamper-evident?** **Ruling: Governor wins — export signs
  broken chains, truncation verifies, key deletion launders to INTACT
  unsigned, crash loses the trail, concurrent runs fork seq.** A signed
  bundle over a broken chain is false proof to an auditor.

## P0 — must-fix before any pilot (owning file)

- [x] CI artifact must exclude the private signing key (bundle + pubkey
  only). (`actions/run/action.yml` — not ci.yml)
- [x] `rm` denylist: normalize flag variants + cover Windows destructors. (`src/policy.ts`)
- [x] Bash path jail (realpath cwd + containment) or downgrade the claim. (`src/tools/jail.ts`, `src/tools/bash.ts`)
  — kept STRICT string-based deny (all absolutes + `..`), relabeled honestly:
  file tools use the realpath jail, bash is the string equivalent.
- [x] Redirect over-permit: `>` into `CHAIN_RX`, backticks + `<` into
  `UNMEMORABLE_RX`, re-screen remembered matches. (`src/policy.ts`, `src/remember.ts`)
- [x] Repair edit/write remembered match + `edit:edit:` prefix; make
  dangerous heads promotable as deny-only. (`src/remember.ts`, `src/policy-store.ts`, `src/loop.ts`)
- [x] `edit` self-protection; block `read` of `.codewhip/key` + `.env` content. (`src/tools/edit.ts`, `src/tools/read.ts`)
- [x] Linux CI break: backslash join in `audit.test.ts` `writeKey`. (`src/audit.test.ts`)
- [x] Audit hardening: export gates on verify; truncation fails; key
  deletion reads BROKEN; flush per-append; seq lock. (`src/audit.ts`, `src/loop.ts`, `src/index.ts`)
  — export gates on `verifyChain` (not just parse); signed-chain + deleted
  key reads BROKEN; per-call `appendEntry` with fsync + mkdir-lock (crash
  loses ≤1 entry). Known limits (no schema change): tail truncation is
  invisible locally (middle deletion fails via seq/prev_hash) — the export's
  `chain_tail` + pubkey is the external anchor; sig-strip + key-delete
  laundering needs that anchor too.
- [x] Promotion hardening: distinct-runIds + recency + caps; approve
  validation; re-validate on load; require `preview_hash`. (`src/policy-store.ts`, `src/remember-store.ts`, `src/index.ts`)
- [x] Scrub gaps: provider key formats + lowercase/short keys; scrub share
  `error` + trace preview at write. (`src/redact.ts`, `src/share.ts`, `src/loop.ts`)
  — added provider-agnostic high-entropy net (letter+digit, 20+) alongside
  `nvapi-/sk-/AKIA/ghp_` + PEM + email + ENV_CAPS/ENV_SECRET; no invented
  provider prefixes. Best-effort by design; `.env` read-denial stays first net.
- [x] Log pre-loop refusals as content-free deny with `prompt_hash`. (`src/loop.ts`, `src/outcomes.ts`)
  — private-without-consent + missing-key log `deny:route:*` with
  prompt_hash + error hash, zero prompt content.
- [x] CI injection: prompt via env var, SHA-pin actions. (`actions/run/action.yml`)
  — prompt/provider/model/class via env + quoted bash array; artifact is an
  explicit allowlist (outcomes/audit/shares/pubkey/policy.md — never the
  private key); checkout/setup-node/upload-artifact SHA-pinned with `# v4` comment.

Note (2026-09-11): opencode (`anomalyco/opencode`) used as REFERENCE only
for basic patterns (allow/ask/deny semantics, doom_loop concept, .env defaults).
Nothing copied blindly — no TUI/MCP/skills/provider-matrix scope. Kill-list holds.

## P1 — next, in order, after P0 green

1. Verdict signal (`verdict` enum + `codewhip verdict` CLI; metrics waits).
   — SHIPPED 2026-09-11 (154/154): `.codewhip/verdicts.jsonl` sidecar
   (latest-wins per runId), `codewhip verdict <prefix> <accepted|edited|
   reverted|rejected>`, `runId` printed per run, metrics joins for
   accepted-rate. `outcomes.jsonl` v1 untouched on disk (still writes
   `verdict: null`; join is in-memory) — no migration, old readers fine.
2. Offline wedge demo (`codewhip demo --deny` on the $0 fake port).
   — SHIPPED 2026-09-11 (155/155): `src/demo.ts` scripts five disasters
   (rm -rf /, push --force, chaining, redirection, absolute-path escape)
   + one safe `git status` through the real loop + policy + audit.
   Live proof: `5 denied / 1 allowed`, chain INTACT, `$0.0000` receipt.
   No network, no key, no new deps.
3. Pasteable artifact (`run --share --print` Markdown receipt block).
4. Passable gate (price sensenova/alibaba/mistral or re-route polish; derive price key from `PROVIDERS`).
5. Truth to model (reword chaining claims; fix search comment).
6. Pack honesty (write denies, normalization, or drop phantom claims).
7. Reporting honesty (decision buckets, untracked spend, `missing===2`, `--last`/`--replay` parity, empty export).
8. Drift + hygiene (five tools, single-shot, receipt legend, gate OPEN label, dead branch, REPL receipt, vacuous assertions).

## Deferred (not now + reason)

- `memory.md`/`notes`/distill/graph: behind the verdict signal.
- Sandbox profiles, network isolation: until paid pain.
- Pack registry, private hosting, SSO/retention, hosted share: until audit links appear in PRs.
- Full provider matrix: until users scream.
- TUI/desktop/IDE, MCP, skills, training: per kill list.
