# Torvalds Architecture Review — five simulations, converged (2026-09-18)

> Five independent Linus Torvalds simulations reviewed the v0.3.0 tree, each
> on one layer: (1) architecture topology, (2) agent loop/execution, (3)
> security & tools, (4) state/persistence/audit, (5) paper novelty as a
> program-committee chair. This file converges them; verbatim sim findings
> are summarized here with the load-bearing file:line evidence. Decisions
> taken on the back of it are recorded at the bottom. Additive ruling; no
> frozen schema changed by this document.

## Converged verdict

**No full rearchitecture. The core survives every reviewer.** The ChatPort
seam (`src/provider-port.ts`) with its typed `RetryableKind` failure union,
the bounded one-shot retry ledgers in the loop, the hash-chain math, the
permission-ladder precedence, and the honest labeling culture ("harness
jail, not OS isolation") were called out as KEEP by every sim. What fails
is everything the codebase **claims but doesn't do**, plus one phantom
product. Scope of this pass: amputation of `src/lib/`, and the P0
"harness lies" fix batch (§3 below).

## Per-sim verdicts

| Sim | Lens | Verdict |
|---|---|---|
| 1 | Architecture | Scoped: kill `src/lib` (amputation), gut `index.ts` eventually; core stays |
| 2 | Agent loop | Scoped: 4 local surgeries; loop core is sound |
| 3 | Security | Scoped: bones right, 5 concrete fixes, none tear-down |
| 4 | State & audit | Scoped rearchitect: append/lock contract consolidation |
| 5 | Paper novelty | No A* paper today; one viable path (policy mining), deferred by owner |

## Findings acted on in this pass (P0 — "the harness lies" class)

1. **CRITICAL — npm library ships fabricated responses.** `src/lib/proxy.ts:384-410`
   records success before any network call and returns hardcoded "Placeholder
   response…" completions with invented usage. The Workers deployment
   (`workers/src/index.ts`) serves it; the exports map publishes it. Double-
   broken: `lib/storage.ts:60` reads `process.env` (absent in Workers), and
   `build:lib` fails (TS6059 — lib imports the registry leaves outside its
   rootDir). Plus drifted routers/price tables (lib routes polish→sensenova
   vs CLI→kilo) and zero in-repo consumers. **Decision: kill src/lib +
   workers + exports map. serve.ts is the only proxy.**
2. **MAJOR — repeat-memo redaction bypass.** `src/loop.ts` stored RAW tool
   output in the memo before redaction; repeat calls replayed it unredacted,
   and the repeat's `result_hash` covered different bytes than the first
   call's. Fixed: redact at store.
3. **MAJOR — memo serves stale tree after bash.** Memo cleared on
   edit/write only; `bash "npm pkg set …"` then `read` replayed stale
   content. Fixed: bash success clears the memo.
4. **MAJOR — "non-overridable" denylist bypassed by spelling.** Verified
   against the compiled module: `git.exe push --force`, `g"it" push --force`,
   `cmd.exe /c …`, `iex (gc …)`, `start-job { … }` all classified `ask`
   (silent under `--yolo`). Fixed: spelling normalization + PowerShell
   interpreter heads; banner reworded to the true claim.
5. **CRITICAL — audit entries silently lost under lock contention.** Lock
   spin (~0.5–1.5s) < stale threshold (5s); `appendEntry` failure swallowed
   two frames up; the chain stays "valid" with holes the verifier cannot
   see. Fixed: spin ≥ threshold + margin, read moved outside the lock,
   failures surfaced loudly in the run summary.
6. **CRITICAL — pre-key forgiveness = forgeable unsigned prefix.** An
   attacker with FS-write but no key can prepend fabricated entries with
   backdated ts and re-chain them; `--verify` reports INTACT. Fixed: `init`
   appends a signed genesis entry bounding the unsigned prefix.
7. **MAJOR — /model × rotation sends foreign model ids.** Rotation
   candidates were bare strings resolved against whatever port `current`
   held; after a live `/model groq`, a 429 made the loop send kilo model
   ids to groq → terminal death. Fixed: rotation candidates are
   `FailoverTarget[]` (label+model+port), structurally eliminating the
   interleaving; the pending switch is no longer consumed on terminally
   failed turns.
8. **MAJOR — task_stop/timeout orphan process trees on Windows.** Only the
   direct child (powershell.exe) was killed; every backgrounded dev server
   leaked its port (120s timeout guarantees it). Fixed: `taskkill /pid /T /F`
   on win32, process-group kill on POSIX, honest status messages.
9. **MAJOR — flat 60k compaction ceiling keyed to nothing.** 8k-window free
   relays died with terminal 400s before the gate fired; 200k models got
   shredded at 30%; chars/4 underestimates CJK ~4×. Fixed: optional
   `contextWindow` in the registry leaf, ceiling = min(60k, 0.7×window),
   non-ASCII codepoints count ~1 token each.
10. **Smalls fixed:** delegate specs no longer claim child webfetch (the
    loop denies it); repeat-nudge appends after content instead of
    replacing it (compaction + nudge used to destroy the data); retry-wait
    dropped the redundant `failedOver === 0` gate (`waitedOnce` is the
    policy); fakePort strict mode (throw on over-consume); secret-filename
    net gained `.envrc`/`id_rsa`/`id_ed25519`/`.npmrc`/`secrets.yaml`;
    `policy.md` is now self-protected from yolo writes; remembered
    curation dropped `find` (`-exec` carries arbitrary commands past the
    chain ban) and the `npm run` grant message states the compose risk
    (stored `npm run *` + one approved package.json write = prompt-free
    code exec).

## Findings recorded, deliberately deferred (with owners: none yet — claim one before building)

- **TOCTOU in the jail** (jail check-then-use; junction race on Windows
  needs fd-verified writes). Real but needs an OS-isolation story or an
  explicit single-writer assumption in the threat model.
- **Key rotation** (entries carry no keyId; rotation bricks the chain
  verdict indistinguishably from tampering). Needs keyId + key-set verify
  or in-chain rotation records.
- **JSONL contract consolidation** (7 append dialects, 6 skip-garbage
  policies, no multi-process tests; outcomes reader does zero validation;
  outcomes/verdicts split-brain with a permanently-null frozen column; no
  v2 migration story). One `jsonl.ts` module + validation + a written
  migration contract.
- **Parallel tool execution** — needs the candidate-list data structure
  (now done for rotation) extended to per-turn tool batches with
  audit-ordering discipline.
- **Audit tail caching + `--replay` honesty** (append is O(n²); "replay"
  is a tail printer). Also PowerShell→cmd evaluation (measured 308–486ms
  vs 91–102ms startup; would also make the cmd-shaped destructor denies
  semantically honest).
- **`skipPolicyDenies` kill switch ships in the production binary**
  (bench-only plumbing that disables the denylist; gate it on env).

## KEEP (every sim endorsed; do not "fix" these)

- `provider-port.ts` — the contract and `RetryableKind`. The spine.
- The registry leaves (`provider-registry.ts`, `free-chain.ts`) as
  zero-import data with their institutional-memory comments.
- The loop's bounded one-shot ledgers, never-throws partial-transcript
  contract, honest metering (`usageEstimated` discipline).
- The permission ladder's precedence order (verified end-to-end by Sim 3)
  and the audit chain's math (canonical JSON, sig-covering prev_hash,
  refuse-to-export-broken-chain, tested tamper detection).
- The honest-labeling culture (SECURITY.md, jail.ts comments, "est."
  receipts, untracked-never-fiction pricing).

## Paper verdict (Sim 5; recorded, deferred by owner decision)

**No A* paper lives in the tree today.** Novelty calls: tamper-evident
chain = applied log transparency (Schneier–Kelsey, CT/RFC 6962, in-toto);
verdict flywheel = incremental over Mem0/Letta/Reflexion; eval harness = a
smoke suite next to SWE-bench; metered failover = a router with a
conscience; delegation attribution = sound design, not a claim. **The one
viable A* path (3–6 solo months): policy mining from repeated one-bit
human declines, measured as a method** — thesis: mined declines compile
into pre-flight denies whose generalization (precision/recall on held-out
evasion variants and benign near-misses vs known ground truth) is
measured, and harness-side enforcement resists indirect prompt injection
at equal rule text where prompt-stated rules fail, at a measured
false-deny cost. Requires: run `src/bench` (never produced a result file),
fix the PROMPT/COMPILED rule-text confound, ≥30 cells with Wilson/McNemar/Holm,
an authored-rules baseline, a mining-recovery harness, and a grown task
corpus. Until then the honest ceiling is workshop/SEIP/demo + badged
artifact. Prerequisite per Sim 1: the artifact must be reproducible as
described (hence the lib amputation).
