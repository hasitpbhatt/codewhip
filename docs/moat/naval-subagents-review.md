# Naval Review — Subagents & Delegation (commits b16dd96 + 396fc56)

*Date: 2026-09-12 · Scope: `src/subagents.ts`, `src/tools/delegate.ts`, `src/tools/delegate_many.ts`,
`src/subagents.test.ts` (16/16 pass, run locally), README "Subagents", `docs/moat/00-convergence.md`
overturn addendum, plus the enforcement surfaces each claim touched (`src/loop.ts`, `src/audit.ts`,
`src/metrics.ts`, `src/outcomes.ts`). The reviewer is the persona that voted subagents onto the kill
list. Read accordingly.*

---

## One-Line Verdict

**I was wrong to make the subagent ban permanent, and right about why I was afraid — and this
implementation is the proof of both halves: it took five independent enforcement layers to make
delegation safe (the danger was real), and the frozen schema absorbed every child run without
moving (the fear was wrong).**

---

## Re-Litigating the Kill List

My call, in the record: "Ship streaming, subagents, and MCP never or last (kill list holds)"
(`07-committee.md`), with the cost of being wrong priced as "building streaming or subagents first
buys demo minutes but no compounding. Reversible." Two things went wrong with that call, and one
thing went right.

**What went right:** the instinct. Delegation is the single fastest way to unlog, unmeter, and
unscope autonomy in one move. A child run that isn't on the chain is unlogged autonomy. A child
run without a budget is unmetered autonomy. A child that inherits the parent's authority is
unscoped autonomy. All three enemies in SOUL.md, multiplied by fan-out. The feature deserved
suspicion and got it.

**What went wrong #1 — the premise I never checked:** I assumed delegation would fork the audit
model (which agent's seq appends next) and therefore dilute the one asset that matters. The code
disproves it. `appendEntry` derives global `seq`/`prev_hash` from the tail per append under a
mkdir-lock (`audit.ts:125-182`), so parent and child appends interleave onto one chain under their
own runIds. The frozen v1 schema composed unchanged. My kill-list call rested on an architectural
assumption I could have tested in an afternoon and didn't. That's on me.

**What went wrong #2 — a sequencing gate hardened into a law.** My own cost-of-wrong note said
"reversible." What shipped after compaction, undo, and plan mode — the exact order the committee
demanded — was never actually forbidden. A ruling that rests on evidence should die the same way:
this one was overturned by code, the schemas didn't move, and the overturn is dated and recorded
in `00-convergence.md`. That is the strongest signal in this commit — bigger than the feature. An
organization that can reverse a ruling with evidence, in writing, without schema drift, is
compounding on a second axis.

**Did the implementation preserve what I was protecting? Verified in code, not in the README:**

1. **The meter.** Children inherit the parent's *remaining* budget live at exec time
   (`delegate.ts:71` → `loop.ts:650-651` → `subagents.ts:231`) and enforce it inside themselves;
   folded child spend trips the parent's check mid-run — the test at `subagents.test.ts:324-356`
   makes the child stop at its inherited ceiling and the parent die honestly at 170/150. Metrics
   count child spend exactly once (`metrics.ts:73` skips child records for run/spend bars via
   `parent_run_id`). Delegation cannot spend off-book. This was *not* true at b16dd96; 396fc56
   fixed it. Good.
2. **The trail.** Every child tool call lands on the global hash chain under the child's own
   runId; the child writes its own outcome record naming its parent; the child's report returns
   through the parent's normal tool path — redacted *before* the cap slice (`loop.ts:675-683`).
   And delegate is excluded from the run memo (`loop.ts:39`, `616-630`, pinned by test): a memoized
   child result would be a lie twice — stale output, hidden spend. Delegation widens the audit
   surface. That is the only direction this feature was ever allowed to grow in.
3. **The scope.** Children get zero authority that wasn't already allow-class: read/search/webfetch
   only, specs never advertised (`toolSpecs(1)` returns three tools), plan-mode refusal *pre-ladder*
   (`loop.ts:501-510`) so no remembered rule or `--yolo` can ever arm a child, a depth belt that
   denies a rogue child delegate call before the ladder as `loop:max-depth` (`loop.ts:491-497`),
   children cannot prompt a human (`loop.ts:528-533`) and cannot create remembered rules. Depth cap
   is one constant, `MAX_DELEGATION_DEPTH = 1`, enforced in three places that don't trust each
   other. A file in `.codewhip/agents/` can override the prompt, the model, and the step count —
   and nothing else. Authority rides structure, not prompt text.
4. **Leverage.** No agent DSL, no registry server, no marketplace, no new runtime dependency. Agent
   definitions are flat markdown with four frontmatter fields. The built-ins are three paragraphs.
   251 + 93 + 133 lines of implementation; the two tools respect the <150-line rule. Zero new
   policy surface, one new audit surface.

So: was the overturn of my call legitimate? Yes — completely. The overturn process is the moat.
The feature is the evidence.

---

## The Three Questions

**Does it create compounding value?** Split the feature in two. The parallelism is rented —
`delegate_many` buys demo minutes, and I said exactly that in the debate. Nothing has changed; a
4-wide fan-out is not an asset. The trail is owned: children deposit into the same
`outcomes.jsonl` / audit chain / metrics files as any run, at fan-out speed, with attribution
(`parent_run_id`), so the repo's scar tissue accumulates faster — but that is throughput on
existing assets, not a new asset. The genuinely compounding piece is structural: delegatability is
the wedge (creed 4), and the agent spawning children is the same shape as the senior handing the
tool to the intern. Every guard added here — budget inheritance, per-child runId, pre-ladder
refusal — is trust capital for the actual product. Delegation that *deposits* verifiable record
instead of consuming trust is the only version of this feature worth building. They built that
version.

**Is it simple?** Mostly, and the tells are in the refusals. Every guard is a sentence a child can
read: "subagents cannot delegate." "at most 4 entries." "task too long — split the work." No
policy language, no config grammar, no timeout zoo. Concurrency is `Promise.all` with a cap — not
a scheduler, not a pool, not a work-stealing queue. Agent files fail closed on any malformation
and are skipped, never guessed at. The one exotic construct is a dynamic import to keep the module
graph acyclic — the right amount of exotic. Two cosmetic notes: `subagents.ts` at 251 lines is a
module, not a tool, so it doesn't break the rule, but the parser wants to be its own file; and the
rotation-forwarding conditional (`subagents.ts:236`) is the kind of clever-but-correct subtlety
that earns its comment. Keep it.

**Does it respect the user's time and attention?** This is where the feature earns its keep.
Delegation without a trail is a demand for blind trust — the user's attention becomes the audit
mechanism, continuously. With the trail, attention is spent once: glance at the receipt, run
`--verify`. The parent's context stays clean (summary-only return, fresh child transcript); child
progress streams prefixed `[<agent>]`; fan-out results return in entry order; a >4 fan-out refuses
before spawning a single child. Three attention leaks remain, listed below.

---

## Where It Still Leaks (in order)

1. **The audit lock is now the weak point of the trust product — not subagents.** `appendEntry`
   returns `false` silently after ~1.25s of cross-process lock contention (`audit.ts:128-134`) and
   the call site ignores the return; a stale-lock steal after 5s (`audit.ts:139-140`) can fork
   `seq`/`prev_hash` and make `verifyChain` cry tampering on honest data. A silent entry drop or a
   false tamper alarm in the chain is not a bug — it is a brand event. Count drops in the run
   receipt at minimum; fail loudly when a child deny is dropped; make the critical section O(1) by
   caching the tail. This is the one fix that protects the core asset, and 396fc56 didn't touch it.
2. **Fan-out budget snapshot ×4.** All four children in one `delegate_many` inherit the *same*
   remaining-budget snapshot (`loop.ts:650-651` is computed once per tool exec), each self-enforces
   against it, and the parent's check trips only after the fold returns. Aggregate exposure is
   bounded by 4 × remaining, not remaining. Divide the budget across the fan-out, or abort
   siblings when a fold crosses the line. The single-child case is airtight and tested; the
   parallel case is honest-after-the-fact.
3. **Remembered webfetch grants ride into children.** A child webfetch on a host the human once
   said "always" to proceeds with no gate, non-interactively, mid-fan-out — one audit line among
   dozens. The README now documents it ("a host you already approved this run is the same grant a
   child uses"), and the parent could do the same thing, so it grants no new authority. True, and
   still the wrong call: delegation adds a masked, parallel, one-remove channel. Documenting a
   pivot is not closing it. The fix is one line — strip webfetch rules from a child's inherited
   `remembered` — and it should be taken.
4. **`delegate_many` reports `ok` when some children fail** (`delegate_many.ts:122`:
   `failed < runs.length`). The parent model must parse prose lines to notice a failure. Make `ok`
   mean all succeeded, or surface the count structurally.
5. **Timeout-path linkage.** A delegate that times out never records the child runId on the
   parent's trail (`delegate.ts:82` appends it only on success); the parent's entry carries the
   fallback-text hash. The two records connect by timestamp archaeology. Cheap fix, auditor-visible
   payoff.

---

## Final Judgment

| Question | Answer |
|---|---|
| Was the kill-list call wrong? | **Permanent yes, momentary no.** Right to suspect, right to sequence, wrong to assume the audit model couldn't compose — an assumption code disproved and I never tested |
| What I was protecting — did it survive? | **Yes, all four: meter, trail, scope, leverage.** Two of them (meter enforcement, metrics honesty) are stronger than before this feature |
| Does it compound? | The trail does; the parallelism doesn't — and the design knows the difference |
| Is it simple? | Yes — guards are one-line refusals, caps are constants, agent files are flat markdown, zero deps |
| Does it respect attention? | Yes — attention spent once at the receipt, not continuously in the loop; three leaks listed above |
| Ship-blocking? | Nothing blocks the feature. Item 1 (audit lock) blocks the *trust narrative* and should land before the <$0.05 proof run |

The committee was right that subagents bought demo minutes. It was wrong that demo minutes were
all they could buy. The meter, the chain, and the depth cap turned a rented trick into compounding
trust — and the fact that my ruling was overturned in writing, by evidence, with frozen schemas,
is worth more than the feature. Update the ruling. Watch the lock.
