# Li Lu Review — Subagents & Delegation (commit b16dd96)
*Date: 2026-09-12 · scope: README "Subagents", `src/subagents.ts` + delegate tools, `docs/moat/00-convergence.md`, `docs/roadmap.md` subagents line, `docs/moat/07-committee.md`*

---

## One-Line Verdict

**Delegation widens the moat — it is the first shippable answer to "how do you delegate without going blind," and it adds zero policy surface while adding audit surface — but two meter-honesty defects (a metrics double-count and a late-enforced child budget) must be fixed before the launch-gate proof run, because the brand is the honest meter and the aggregate meter currently lies.**

---

## The Question That Matters

The wedge is *delegatability*: the terminal agent a team lead lets an intern run on prod-adjacent code. Delegation is not adjacent to that wedge — it **is** the wedge, stress-tested. So the review question is narrow: does this feature let a team lead fan out work with the same confidence they have in a single supervised run?

Compare the field on the only axis that counts:

| | Delegates? | Child runs auditable? | Meter honest? |
|---|---|---|---|
| Closed-box incumbent | Yes | No — black-box children, no per-child trail on your disk | Vendor's meter, vendor's margin |
| OpenCode | Partial | Permissions are a safeguard, not a sandbox; state doesn't compound | Unmetered bill |
| **CodeWhip** | **Yes (depth 1)** | **Yes — global hash-chained log, per-child runId, per-child outcome record** | **Folds into the parent's receipt** |

CodeWhip is now the only one of the three where delegation produces *more* verifiable record rather than less. That is the moat widening — not because subagents are novel (everyone has them), but because this is the only implementation where delegation **deposits trust state instead of consuming it**.

## What I Verified in Code (not in the README's word)

- **Read-only is enforced in three independent layers.** `toolSpecs(depth)` hides edit/write/bash/delegate from children entirely (they never see the specs — no tokens burned on refused calls); the loop denies a rogue child delegate call pre-ladder as `loop:max-depth`; `runDelegate`/`runDelegateMany`/`runChildAgent` each re-check the cap. Plan-mode parents cannot delegate (`plan:read-only`). Children run `yolo: false` with no `askUser` — the ask ladder fails closed inside a child; nothing inside can ever prompt a human. This is belt-and-braces-and-suspenders, done right.
- **The audit model composed instead of forking.** This is the load-bearing architectural fact that justifies the overturn (see below). `appendEntry` reads the chain tail under a mkdir-lock and derives global `seq`/`prev_hash`, so interleaved parent/child appends land on one chain, per-call flushed, under the frozen v1 schema — unchanged. Every child tool call is individually hash-chained and signed under the child's own runId; every child writes its own `outcomes.jsonl` record. Nothing is a black box.
- **Receipt folding is honest on failure paths too.** `onChildUsage` fires even when a child fails or is cancelled; the `estimated` flag propagates into the parent's bucket; `delegate` is excluded from the run memo (never cached, never hidden). The parent's terminal receipt carries the true spend.
- **The engineering is boring, as demanded.** Zero new runtime deps, flat frontmatter agent files, 88- and 128-line tools (under the 150-line rule), a dynamic import to keep the module graph acyclic, three built-ins that are three paragraphs of prompt text. No framework, no registry server, no agent DSL.
- **Definition of done holds.** 263/263 tests pass (audit-chain integration, depth guard, plan-mode refusal, memo exclusion, fan-out cap all pinned); lint 0/0; typecheck clean; build clean.

## Findings (ordered by severity)

**F1 — `codewhip metrics` double-counts child spend. Sharp.** Each child writes its own outcome record, and its usage is *also* folded into the parent's record. `metrics.ts` sums `usageByModel` across every record — so child tokens are counted twice in `$/task` and spend, and a single user command with a 4-child fan-out registers as 5 "runs," inflating the denominator of blocks/100 and skewing every H1 metric bar. The live receipt is honest; the aggregate is not. Fix: an optional `parent_runId` on the outcomes record — additive, byte-identical to existing fields, exactly the freeze-compatible precedent set by `usageByModel[]`/`failovers[]` — and metrics counts child spend once.

**F2 — No structured parent→child attribution in the trail.** The frozen audit schema has no parent link, and hashes are one-way: an auditor can see a delegate entry under the parent's runId and a run under the child's runId, but can only connect them by timestamp inference. The overturn rationale was "the global chain composes instead" — composition is proven in code; *attribution* is currently inferential. The same optional `parent_runId` on outcomes fixes this without touching the frozen audit schema. Do not widen the audit schema for this — the outcomes side is the additive surface.

**F3 — The child budget is enforced a turn late, not live.** `childArgs` omit `tokenBudget`; a child can burn up to 25 steps × per-call tokens inside the 10-minute wall clock before the parent regains control, and the parent's check trips only at the next turn boundary — `delegate_many` multiplies the exposure ×4 concurrently. The commit message claims usage folds into "receipt buckets and budget (never off-book)": receipt, true; budget, enforced late. Pass the parent's remaining budget into the child — one line — or check the budget immediately after each fold.

**F4 — Child `webfetch` is advertised but mostly inert.** Children receive the webfetch spec, but webfetch is ask-class and children run non-interactive with no asker — every child webfetch is denied as `held for approval` unless the origin is already a remembered rule (children do inherit remembered shapes). Fail-closed, so not a security issue — but the delegate spec's "Children can only read/search/webfetch" overpromises. Fix the wording (read/search, plus webfetch only for remembered hosts) or propagate parent consent at delegation time.

**F5 — The overturn is under-recorded.** The roadmap line documents the decision, but the Rulings log in `00-convergence.md` — additive, newest last, the repo's own convention — was not appended. Precision also matters: committee ruling 5 was a *sequencing gate* ("no subagents until compaction ships and is boring"), not a kill-list item; compaction shipped 2026-09-11 and delegation shipped 2026-09-12, so "boring" after one day is generous. The overturn itself is legitimate — the ruling rested on the assumption that delegation would fork the audit model, and the implementation disproved that assumption with the frozen schema composing unchanged. Overturning an evidence-based ruling with new evidence is the process working. But write the ruling in the log with the precise basis, or the convergence doc starts drifting from the code — the no-shadow-roadmaps rule applies to governance docs too.

**F6 (minor) — Agent files are per-machine.** `.codewhip/agents/` sits under the gitignored `.codewhip/`, so a team cannot commit its agent definitions, and packs don't carry them yet. Correct for local-file v1; the pack registry (H2) should treat agents as packable policy-adjacent state.

## Is the Single Bet Preserved?

Yes — and strengthened. The bet was never "an agent that works alone"; it was "an agent a responsible human can hand off." Delegation with a per-child trail is the natural extension of that sentence, not a second bet. The discipline that kept it singular: delegation grants **zero authority** beyond tools that are already allow-class, so the policy surface did not grow — only the audit surface did, which is precisely the direction the moat compounds in. Depth cap 1, three built-ins, no marketplace, no agent-server: the kill list bent nowhere.

The committee was right for its moment, and the overturn is what its own process prescribes. That is the strongest signal in this commit — not the feature, but the demonstrated ability to reverse a ruling when the code disproves its premise, and to keep the schemas frozen while doing it. Incumbents cannot cheaply copy the *combination*: delegation, a global signed chain, folding receipts, and $0-capable routes in the same run. Each piece is copyable; the composition is the moat, and this commit added a room to it.

## Final Judgment

| Question | Answer |
|---|---|
| Where is the durable advantage? | Delegation that *deposits* auditable, metered, per-child state — the only implementation in the class where fanning out widens the trail instead of blinding it |
| Does the moat widen or narrow? | **Widens.** Zero authority added, audit surface added, complexity kept boring (no deps, flat files, depth cap 1) |
| Is the single bet preserved? | **Yes.** This is the wedge stress-tested, not a second bet |
| Ship-blocking? | Nothing blocks the feature. Two things block the *narrative*: fix F1 (metrics double-count) and F3 (late child budget) before the <$0.05 launch-gate proof run — the proof run's receipts must be unimpeachable |

**Moat verdict: widened this week more than any week since the audit chain shipped. Land F1/F3, append the ruling to the convergence log, then take the proof run.**
