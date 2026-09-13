# Review: subagents & delegation (b16dd96, hardening 396fc56, polish 0b1c030)

Reviewed files: `src/subagents.ts`, `src/tools/delegate.ts`, `src/tools/delegate_many.ts`,
`src/tools/registry.ts`, `src/loop.ts`, `src/policy.ts`, `src/subagents.test.ts`, with
`src/audit.ts`, `src/outcomes.ts`, `src/checkpoints.ts`, `src/metrics.ts`, `src/provider.ts`,
`src/index.ts` read for the concurrency/propagation questions. Test suite run locally: 266/266 pass, claim verified.

## Verdict

The core design is right and I'm not going to pretend otherwise: children get a fresh
transcript, plan-mode refusals pre-ladder, their own runId on the global hash-chained
audit log, their own outcome record, and a summary-only return. Delegation is allow-class
*because it grants no authority* — that is the correct way to reason about it, and most
harnesses get this wrong. The signal chain (parent SIGINT → loop → withTimeout controller
→ exec → child loop → provider fetch abort) is actually wired end to end; I checked
`provider.ts`, the fetch really does die.

But there are three real bugs, one of which is in the security-model *documentation*, which
is the worst place for a bug to be. And the depth guard is layered in a way that is
redundant today and wrong tomorrow. Fix these before anyone builds on top.

---

## 1. `delegate_many` hands every child the same budget snapshot — concurrent oversubscription

`src/tools/delegate_many.ts:98` and the exec site in `src/loop.ts:656-657`:

```
remainingBudget: args.tokenBudget === undefined ? undefined
  : Math.max(0, args.tokenBudget - (promptTokens + completionTokens))
```

This is computed once at exec time, then `runDelegateMany` copies the **same number** into
all N (up to 4) concurrent children. Each child enforces its inherited budget "live"
against its own spend only. So with 60k remaining, four children can each burn 60k —
4x oversubscription — and the overspend is only *discovered* when the fold trips the
parent's check at the next provider turn. The commit message says "live budget
enforcement"; it is live per-child, not live for the fan-out. That's the difference
between a budget and a suggestion.

The test (`subagents.test.ts`, "child token budget is enforced live") covers the single
`delegate` case only. The concurrency case — the one `delegate_many` exists for — is
untested, and it's broken.

Fix: divide the remaining budget across the fan-out (`floor(remaining / n)`, minimum 1),
or serialize the fold per child completion. Either is ~5 lines. There is no excuse for
shipping this as-is.

## 2. `MAX_DELEGATION_DEPTH` is a lie — it only governs 2 of the 4 guard layers

Count the layers that stop a child from delegating:

1. `toolSpecs(depth > 0)` → delegate specs absent from children (`registry.ts:186`) —
   hard-codes "any child", not the constant.
2. Loop guard `isChild && (def.name === "delegate" ...)` → `loop:max-depth`
   (`loop.ts:497`) — hard-codes "any child", not the constant.
3. Tool guard `ctx.depth + 1 > MAX_DELEGATION_DEPTH` (`delegate.ts:52`) — uses the constant.
4. `runChildAgent` guard `opts.depth + 1 > MAX_DELEGATION_DEPTH` (`subagents.ts:223`) — uses the constant.

The constant's own comment says "Depth 1: children cannot delegate (**the union's hard
ceiling for v1**)" — an invitation to raise it later. Raise it to 2 and layers 1 and 2
still deny everything, because they test `depth > 0`, not the constant. The constant
governs nothing that matters and misleads everywhere else. That's worse than no constant:
someone will bump it, run the tests (which pass — they encode depth-1 behavior), and ship
a nested-delegation feature that silently doesn't nest.

Also, layers 2 and 3 emit different refusal strings for the same condition
("delegation depth exhausted" vs "subagents cannot delegate (depth cap)") — pick one.

Redundant *is* correct for a security boundary — I'm not asking you to delete layers. I'm
asking for one predicate, `canDelegate(depth) === depth + 1 <= MAX_DELEGATION_DEPTH`, used
by all four layers, so the boundary has one definition instead of two disagreeing ones.

## 3. The comments describe a security model that the code does not implement

`subagents.ts` header: "read/search/webfetch, **which are allow-class already**."
`policy.ts` delegate branch reason: same claim. `delegate.ts` spec text: "Children can
only read/search/webfetch."

`policy.ts` itself, 30 lines below: *webfetch is ask-by-default* — "the network is the
exfiltration surface." A child runs `yolo: false, stdinIsTTY: false, askUser: undefined`,
so its webfetch verdict is `ask` → "held for approval — non-interactive, **denied**".
The only way a child webfetches is a remembered origin inherited from
`listRules(cwd)`.

Consequences: (a) the docs lie about the trust model — the delegation allow-branch is
justified by "grants no authority beyond allow-class tools", but webfetch is not
allow-class, so the justification is wrong even if the conclusion is defensible;
(b) the child's tool spec advertises webfetch, models will try it, and every attempt is a
guaranteed non-interactive deny that burns child steps. You're paying tokens to
demonstrate your own documentation error.

Fix the comments to say read/search are allow-class, webfetch is inherited-remembered-only.
Optionally drop webfetch from `toolSpecs(1)` unless a remembered origin exists — don't
advertise tools the ladder will refuse; that's the same principle you correctly applied
to edit/write/bash.

## 4. Timeout orphans: the fold can land after the receipt is written

`withTimeout` (`loop.ts:152`) resolves the race with the fallback but the losing
`run(controller.signal)` promise keeps running — that's inherent to the pattern and fine
for bash. For `delegate` it means the aborted child still unwinds, and when
`runDelegate` finally settles it calls `ctx.onChildUsage` → `foldChildUsage` → mutates the
parent loop's `promptTokens`/`buckets`. If the parent loop has already exited and
`appendOutcome` has run (parent finishes its final text turn while the orphan unwinds, or
dies on an immediate provider error), the fold lands in dead locals. Spend vanishes from
the parent's receipt, and `metrics.summarize` deliberately skips child records for spend
(`parent_run_id` de-dup) — so it vanishes from *every* receipt. Off-book spend, the exact
thing this design's commit message promises "never".

Probability is low — abort propagates fast and the child usually settles before the
parent's next HTTP roundtrip — but "usually" is not an integrity guarantee for a receipts
system. The principled fix: `onChildUsage` must only fold while the loop is open; either
have `foldChildUsage` no-op after loop exit and count the orphan's spend via its own child
record, or make the delegate timeout path wait (bounded) for the child's final usage
before returning. At minimum: document the race in `withTimeout` instead of leaving it to
be rediscovered.

Related nit: the timeout fallback "tool: timed out after 600000ms" is generic — the parent
model can't tell whether its subagent died at minute 9 of a 10-minute investigation.

## 5. The questions I was told to look at, answered

**Dynamic import cycle breaker (`subagents.ts:252`).** Correct and the right pragmatic
choice. The static graph `loop → registry → delegate → subagents → loop` would be a real
cycle; `await import("./loop.js")` breaks it, costs a module-cache hit per delegation
(nothing), and is documented in place. I won't ask for a fancier DI ceremony in a codebase
with zero runtime deps. The debt is not the import — it's that `LoopArgs`,
`ChildRunOptions`, and `ToolContext` triplicate the same seven fields with three slightly
different shapes (see debt list). The cycle is a symptom of that.

**Signal propagation.** Verified end-to-end: `index.ts` SIGINT controller → `args.signal`
→ `withTimeout` outer listener → per-tool controller → `delegate` exec signal →
`ChildRunOptions.signal` → child `LoopArgs.signal` → child port fetch abort + child
step-start `aborted` checks. The provider genuinely aborts the fetch. This is done right;
no complaints.

**Promise.all vs the audit chain and checkpoints.** The chain holds. `appendEntry`
takes the mkdir lock, re-reads the tail for `seq`/`prev_hash` under it, writes, releases;
concurrent children serialize correctly, and the per-call flush bounds crash loss at one
entry. Tests verify `verifyChain` after `delegate_many`. `outcomes.jsonl` is one
`appendFileSync` of one line per child — interleaving is theoretically possible for
multi-KB records on some filesystems, practically not your problem today; if it ever is,
the fix is a shared lock like audit's, not a rewrite. Checkpoints: children cannot
checkpoint because they cannot edit/write — `captureBefore` only fires for edit/write,
which `toolSpecs(1)` doesn't even offer. The fan-out has no state-corruption surface.
This is what "read-only children" is supposed to look like.

**The `listAgentsWithErrors` two-call pattern.** Fine. The loop reads it once for the
roster; `findAgent` re-reads at every delegate call. That's a handful of files under
8KB each — microseconds, per delegation, in a code path about to spend seconds on a
provider call. Caching would introduce stale-roster bugs to save nothing. Re-reading at
call time is the *correct* semantics (files edited mid-run resolve fresh); the only
inconsistency is that the roster in the system message is loop-start frozen while
resolution is call-time fresh — acceptable, worth one sentence in a comment, not a fix.
Stop optimizing disk reads that don't exist.

## 6. What is actually good (so you don't refactor it away)

- `toolSpecs` filters at construction, not per call — children don't see tools they can't
  use, and the transcript/failover same-specs assumption survives. Right call.
- Delegate is absent from `IDEMPOTENT_TOOLS`, and there's a test proving identical repeat
  delegate calls run two children instead of serving a memo hit. Correct, and tested.
- The body cap on agent files (`MAX_BODY_CHARS = 8000`) with the comment explaining *why*
  (system messages survive compaction — a runaway agent file is a cost amplifier the
  compactor can't touch). That's the level of reasoning I want in every cap.
- Test 14 (child spend folds in and trips the parent's budget) tests the honesty
  property, not the happy path. More of that.
- Parse failures fail closed with per-file reasons that are surfaced to the user, never
  swallowed — the "moment of maximum user investment" comment is correct.
- Error handling: every failure path returns a tool-result string; nothing throws the
  loop. Contract honored.

## 7. Technical debt ledger (fix or explicitly accept)

1. **`label: opts.label as LoopArgs["label"]`** (`subagents.ts:230`). `ChildRunOptions.label`
   is `string`, `LoopArgs.label` is `ProviderId`. The cast papers over the hole; a bogus
   label flows straight into outcome buckets. Make `ChildRunOptions.label` a `ProviderId`
   and delete the cast.
2. **Tool-authority knowledge is scattered across five sites.** Adding a delegating tool
   means touching: `ToolName` union, `lookupTool`'s hardcoded list, the loop depth guard,
   the plan-mode refusal list, `toolSpecs`. One table — `tool → {mutating?, delegating?}` —
   and every guard derives from it. Until then, each new tool is a five-place shotgun
   edit waiting for a miss.
3. **`parseAgentFile` whitespace hole.** `model:  ` (trailing spaces) captures `" "` via
   regex backtracking — passes the empty check, becomes the child's model id, fails at
   provider time with a confusing error. Same for whitespace-only descriptions. Trim the
   captured value in the regex loop. Two-line fix.
4. **Roster is unbounded.** N agent files → N lines (≤200 chars each) in the parent system
   message, every run. Cap the roster or cap the file count before someone's `.codewhip/agents/`
   directory becomes a context-window attack on their own prompt.
5. **Children inherit rotation + retryWait but not `failovers`.** Deliberate, presumably
   (a child riding the parent's port can't hop providers). It's discoverable only by
   reading `loop.ts`. Document it on `ChildRunOptions` where the other forwarding decisions
   are documented.
6. **Pre-existing, but it's in a reviewed file:** `policy.ts:94-101` computes `scope` and
   then `void scope;` — dead computation that survived a commit literally titled "dead
   code". Delete it.

## Required before building more on this

1. Fix the `delegate_many` budget snapshot (divide or serialize) + a concurrency budget test.
2. Collapse the depth guards onto one `canDelegate(depth)` predicate; kill the constant's lie.
3. Correct the allow-class claims in `subagents.ts`, `policy.ts`, and the delegate spec text.
4. Close or bound the fold-after-receipt race.

Everything else is debt to schedule, not blockers. The trust model is sound, the audit
trail is genuinely intact under concurrency, and the abort path works. This is a competent
feature with three fixable lies in it. Fix the lies.
