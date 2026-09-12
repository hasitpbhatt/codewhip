# Don Norman Review: CodeWhip Usability Verdict

**Date:** 2026-09-12  
**Scope:** `src/` as of HEAD, 212 passing tests, zero runtime deps

---

## One-Line Verdict

**CodeWhip is the first agent system where the safety mechanics are visible, understandable, and undoable — but the mental model requires learning three distinct policy layers before the user feels in control.**

---

## The Mental Model: Three Layers, One Gap

The user forms a mental model from what they *see* and *do*. CodeWhip presents three policy layers that operate at different scopes:

| Layer | Scope | Visibility | User Control |
|-------|-------|------------|--------------|
| **Denylist** | Per-call, non-overridable | Printed at deny: `denylist:rm -rf /` | None (correct) |
| **Policy.md** | Pre-flight, promoted from declines | `codewhip policy list` shows denies | `codewhip policy approve "bash:npm publish *"` |
| **Remembered** | Per-shape, user-granted `a` | `codewhip remember list` (missing!) | `a` at prompt, or `codewhip remember forget` (missing!) |

**The gap:** The user sees *denies* and *prompts* but has no single command to inspect "what will this run allow/deny/remember?" The mental model is assembled from scattered CLI surfaces, not presented as a coherent object.

**Where the user feels stupid:** Running `codewhip run "refactor X" --yolo` and getting a deny from a promoted `policy.md` rule they didn't know existed. The `--yolo` banner says "denylist still applies" but doesn't mention *promoted denies* or *remembered rules* — two different override layers with different semantics.

---

## Affordances vs. Mental Model

### What matches ✓

1. **`codewhip rollback <runId>`** — The single best affordance. One command, visible output (`restored: file.ts`, `removed: file.ts`), git-diff-verifiable. This converts "terrifying autonomy" into "auditable autonomy you can hand to a junior." (Norman committee ruling #1)

2. **`--plan` mode** — Run-scoped read-only is the correct affordance for "show me the plan before you act." It reuses the existing permission ladder (deny > ask > allow) rather than inventing a new subsystem. The banner `!! --plan armed: read-only run — edit/write/bash denied for the whole run (even with --yolo)` is honest and visible.

3. **Receipts on every run** — `receipt: 1247 prompt + 892 completion tokens / nvidia:moonshotai/kimi-k3 / $0.0000 (nvidia free tier)` — Honest metering. The `est.` marker on stream-estimated usage is the right honesty signal.

4. **Free chain (`--free`)** — `codewhip free` lists keyless providers first with verified limits. `codewhip run "..." --free` arms a chain that *never bills pay-go*. The affordance matches the mental model: "free means free."

### What mismatches ✗

1. **`--yolo` is a lie by omission** — The banner says "Denylist still applies — never bypassed." It doesn't say: "Promoted `policy.md` denies still apply. Remembered `always` rules still apply." The user types `--yolo` thinking "bypass all prompts" and hits a `policy.md:deny:bash:npm publish *` wall. The affordance (a flag called "yolo") promises recklessness; the system delivers constrained recklessness without explaining the constraints.

3. **No `codewhip remember list` / `forget`** — The user *grants* `always` at the prompt (`a`), but has no affordance to *inspect* or *revoke* what they granted. The mental model: "I said always, so it remembers." The system: "It wrote to `.codewhip/remembered.jsonl` with provenance." The user cannot see, audit, or undo their own memory grants. This is a **gulf of evaluation** — the system state changed invisibly.

4. **Policy promotion is write-only** — `codewhip policy approve "bash:npm publish *"` promotes a decline pattern to a standing deny. There is no `codewhip policy revoke` or `codewhip policy edit`. The user can add friction but never remove it. The mental model of "policy as a living document" is broken; policy is a ratchet.

5. **Rotation vs. Failover vs. Free chain — three flags, one mental model** —
   - `--models a,b,c` = same-provider model rotation (rate-limit/timeout only)
   - `--failover` = one cross-provider hop (may bill pay-go)
   - `--free` = keyless chain (never bills)
   
   These are mutually exclusive but the help text doesn't explain *when to use which*. The user sees three flags for "try another thing when this fails" and must reverse-engineer the semantics from error messages.

---

## Hidden Complexity That Should Be Visible

### 1. The audit chain is invisible until you ask

Every tool call writes to `.codewhip/audit.log` with `prev_hash` chaining and ed25519 signatures. This is the **trust anchor** — but the user never sees it unless they run `codewhip audit --verify`. The receipt prints tokens and cost, but not "this run is cryptographically chained to history." The complexity (hash chaining, signing, verification) is *hidden* when it should be *visible as a trust signal*.

**Fix:** Print `audit: chain INTACT (seq 1..47 signed)` on every run completion. Make the trust artifact visible by default.

### 2. Compaction is honest but invisible until it triggers

`compact.ts` implements a two-tier pruning (truncate old tool outputs → elide whole exchanges) with honest receipts: `compacted: 3 old tool output(s) truncated, 2 exchange(s) elided (est. 78421 → 59104 tokens)`. This is excellent design — but the user only sees it when the transcript *exceeds* the ceiling. There's no affordance to ask "how close am I to compaction?" or "what would be dropped?"

**Fix:** `codewhip run "..." --compact-threshold 50000` (already exists) but add `codewhip compact-preview` showing current estimate vs. threshold and what *would* be dropped.

### 3. Provider health is reactive, not proactive

`codewhip stats nvidia` shows `87% ok over 234 calls, 31 failed`. But the run only prints a health hint *after* a failure: `health: nvidia 87% ok over 234 calls, 31 failed — detail: codewhip stats nvidia`. The user discovers the provider is flaky *after* wasting a run.

**Fix:** Pre-flight check. Before the loop starts, if the selected provider has <90% success rate over >50 calls, print: `!! WARNING: nvidia at 87% success (31/234 failed). Consider --failover or --provider groq.`

### 4. The `bash` tool's string-based containment is a leaky abstraction

`policy.ts:matchWorktreeEscape()` denies `..`, absolute paths, `~/` — but it's **string matching**, not realpath resolution. The file tools (`read`/`edit`/`write`) use realpath jails. The shell tool uses string patterns. This inconsistency is invisible until a user tries `bash: "cd subdir && ls .."` (denied) vs `edit: "../file.ts"` (denied by realpath jail) — different mechanisms, same intent, different error messages.

**Fix:** Unify the mental model. Either both use realpath, or both document "string-based containment for shell, realpath for files" in the same help text.

---

## Where the User Feels Stupid (Ranked)

1. **`--yolo` doesn't mean "yes to everything"** — Hits a promoted deny, thinks the system is broken.
2. **No `remember list/forget`** — Granted `always` on a command, can't find or undo it.
3. **Three "retry" flags with overlapping semantics** — `--models`, `--failover`, `--free` — which one do I need?
4. **Policy promotion is one-way** — Approved a deny by mistake? Edit `policy.md` by hand (not documented).
5. **Compaction threshold is invisible** — Run gets truncated mid-task, user sees `compacted:` receipt but didn't know it was coming.

---

## Where the System Hides Complexity That Should Be Visible

1. **Audit chain integrity** — The crown jewel of trust, printed only on `--verify`.
2. **Provider health** — Known at run start, shown only after failure.
3. **Memory grants** — Written at `a`, never shown again unless you `cat .codewhip/remembered.jsonl`.
4. **Compaction preview** — The algorithm is honest; the user's mental model of "how much context do I have?" is blind.

---

## Recommendations (Norman Priority Order)

| Priority | Change | Rationale |
|----------|--------|-----------|
| **P0** | Add `codewhip remember list` and `codewhip remember forget <tool:shape>` | Close the gulf of evaluation for user-granted memory |
| **P0** | `--yolo` banner must enumerate *all* layers it doesn't bypass: "Denylist, promoted policy.md denies, and remembered rules still apply" | Affordance matches reality |
| **P1** | Print audit chain status on every run completion: `audit: chain INTACT (47 entries, 47 signed)` | Make trust visible by default |
| **P1** | Pre-flight provider health warning before loop starts | Fail fast, not after waste |
| **P1** | `codewhip policy revoke <tool:shape>` and `codewhip policy edit` | Policy must be a living document, not a ratchet |
| **P2** | `codewhip compact-preview` — show current estimate vs threshold, what would drop | Visible mental model of context budget |
| **P2** | Unify or document bash vs file containment model | Consistency of mental model across tools |
| **P3** | Single `codewhip policy preview` showing effective allow/deny/ask for a given prompt | The "what will happen?" affordance |

---

## Closing

CodeWhip's **architecture** is honest: hash-chained audit, metered receipts, checkpoints, plan mode, free chain. The **usability** fails where the architecture's layers leak into the user's mental model as separate, opaque CLI surfaces.

The system doesn't need more features. It needs a **unified policy inspector** (`codewhip policy preview`), **visible memory** (`remember list/forget`), and **honest `--yolo` semantics**. Make the trust artifacts visible by default. The intern at 2am should *see* the safety net, not just hope it exists.