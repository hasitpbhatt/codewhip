# Don Norman Review — Subagents & Delegation

**Date:** 2026-09-12
**Scope:** commits `b16dd96` + `396fc56` + `0b1c030` — README "Subagents", `src/tools/delegate.ts`, `src/tools/delegate_many.ts`, `src/subagents.ts`, `src/loop.ts` roster injection + skipped-file surfacing, `src/index.ts` event forwarding and receipts, `src/tools/registry.ts` spec filtering.
**Lens:** cognitive design. Is the system understandable? Do the affordances match the mental model? Where does the user feel stupid? Where does the system hide complexity that should be visible?

---

## The One-Sentence Verdict

**The subagent that talks is visible; the subagent that spends, waits, and dies is invisible — you built an audit trail a forensics team can love and a terminal a human can't read at the three moments that matter: while it runs, while it bills, and when they want it to stop.**

---

## The Mental Model You're Designing For

A user typed one command:

```sh
codewhip run "review src/loop.ts for bugs"
```

Their model, before this feature, was simple: *I asked, a thing works, the thing answers, a receipt prints.* Subagents explode that model. Now lines prefixed `[explore]` appear from nowhere. Children the user never summoned run for up to ten minutes, read their files, spend their tokens, and hand a single report to a parent the user never sees working. The user's new (correct) mental model must be: **one command = a small team; the team is read-only, on my audit chain, on my bill; I can watch, I can stop, I can inspect.**

Your implementation earns the *read-only*, *audit chain*, and *bill* parts — that's the hard engineering and it's genuinely done. It fails the *watch*, *stop*, and *inspect* parts. A mental model closes only when all six are visible. Right now the user has a fence they can verify after the fact and no window into the yard while the kids are in it.

---

## What You Got Right (Credit, Fast)

1. **The `[explore]` prefix is the single best design decision here.** Child progress streams into the terminal with the agent's name on every line (`src/subagents.ts:248-250`). The user sees *who* is acting, not just *that* something is. Named actors beat anonymous progress bars every time.
2. **Broken agent files now scream.** `0b1c030` fixed the worst silence: `listAgentsWithErrors` (`src/subagents.ts:155-181`) returns parse reasons, and `src/loop.ts:268-270` emits `subagent file skipped: <reason>` as a policy event at run start. The moment of maximum user investment — they wrote an agent file — no longer vanishes into a quiet skip. Good.
3. **The parent sees only the child's final report.** The child's forty tool calls don't flood the parent's context or the user's terminal as tool *results*; they appear as one-line events. That's the right information hierarchy: stream the trace, return the summary.
4. **`runId` tails in tool results** (`[subagent explore runId: ...]`, `src/tools/delegate.ts:82`) give the model — and through it, potentially the user — an attribution handle. The instinct is right.
5. **The spec is honest about its own ceilings.** README states the N × remaining budget exposure of parallel fan-out in plain text instead of hiding it. Telling people the bad news up front is design, not disclosure.

---

## Gap 1 — While It Runs: The Terminal Goes Dead at the Worst Times

**Question: can the user tell what a child is doing while it runs? Partially — then the screen lies by silence.**

- **Silence between child steps.** Child events fire only after each child tool call completes. Between child steps sit provider calls of up to 120s each. A child mid-investigation produces minutes of nothing. Silence at a terminal reads as *hung*, and the standard user response to hung is Ctrl+C — which kills work that was fine. There is no heartbeat, no elapsed timer, no "explore: step 3/10" line. You have `maxSteps` and you don't show it.
- **The chronology reads backwards.** The parent's own acknowledgment line — `▸ ok delegate {"agent":"explore","task":"…"}` — is emitted *after* `def.exec` returns (`src/loop.ts:691`), which is *after* the child finished. So the user watches `[explore]` lines scroll by for minutes, and *then* sees the line that says the delegate call was allowed. The causality is inverted on screen: effect first, cause last. The spawn announcement should print before the child starts; the completion line after.
- **Fan-out with the same name is indistinguishable.** `delegate_many` does no de-dup on agent names (`src/tools/delegate_many.ts:50-59`), so two `explore` children both stream as `[explore]`. Interleaved, the user cannot tell which line belongs to which worker. The prefix needs a discriminator (`[explore#1]`) or the entries should be name-unique.
- **Child event kinds are flattened.** `runChildAgent` forwards only `e.text` and drops `e.kind` (`src/subagents.ts:248-250`); the parent re-emits everything as kind `"tool"` (`src/loop.ts:655`). A child's rate-limit wait, compaction, or policy denial arrives wearing the same `▸` glyph as a successful read. The user can't triage a stream where "waiting 45s on 429" and "ok read src/loop.ts" look identical.

## Gap 2 — What It Cost: The Meter Is Hidden During the Run and Blur After It

**Your SOUL.md says: "Every dollar is metered and visible; the meter is never hidden." During a delegation, the meter is hidden.**

- **Nothing live.** For ten minutes of fan-out the user gets zero spend signal. No running token count, no "children have burned 40% of your remaining budget." The parent's live budget check (`src/loop.ts:448-452`) trips mid-run — good — but the first thing the user learns about spend is the post-mortem receipt. A meter that only speaks at the funeral is not a meter.
- **The receipt can't see the children at all.** Child usage folds into the parent's buckets keyed `label:model` (`src/loop.ts:312-326`). The default case — child rides the parent's model — **merges the child into the parent's bucket**. The final receipt shows one `nvidia:model 12000+4000` line and the user cannot tell whether delegation happened, how many children ran, or what they cost. `LoopResult` doesn't even carry a child-run count. The one line the repo treats as sacred (the receipt) is structurally blind to its newest cost source.
- **Child runIds are effectively unfindable.** They're printed into the *model's* tool result (the user sees it only if the model repeats it), written to `outcomes.jsonl` with `parent_run_id` (no CLI surfaces it — `codewhip metrics` deliberately de-dups children out of the run bars, `src/metrics.ts:73`), and the human-rendered audit view omits runId entirely (`renderAuditEntry`, `src/index.ts:923-926` — no runId column; only `--last` raw JSON has it). The audit trail is *complete* but not *legible*: a parent-child run structure exists on disk that no human-rendered view can show.

## Gap 3 — How to Stop It: One Brake Pedal, Wired to All Four Wheels

- **Ctrl+C is all-or-nothing.** One AbortController is shared by parent and every child (`src/subagents.ts:236`, forwarded through `delegate.ts:70`). The user cannot stop the `explore` child that's spinning while letting `review` and `plan` finish. There is no per-child cancel, no way to detach a child, no way to stop the parent but let children drain. A team with one kill switch isn't a team you can manage; it's a team you can only fire.
- **One slow child destroys three finished reports.** This is the worst defect in the feature. `delegate_many` runs all children under a single 600s `withTimeout` wall clock (`src/tools/delegate_many.ts:128` + `src/loop.ts:152-182`). If one child hits it, the tool result is replaced by `tool: timed out after 600000ms` — the three children that finished in 60s, whose reports are *complete and paid for*, are silently dropped from the conversation. Their runId tail is never printed. The user paid for the work, the work exists on the audit chain, and the system acts like it never happened. That is precisely the "hides complexity that should be visible" failure — the system hides *loss*.

## Gap 4 — List and Inspect Agents From the CLI: You Can't

- There is **no `codewhip agents` command**. Not in `printHelp`, not in `printCommandHelp` topics, not in `trust`. The roster of delegable agents is injected into the *model's* system message (`src/loop.ts:231-242`) and documented in the README for three built-ins — but the user's own custom agents are visible only by `ls .codewhip/agents/` and hoping.
- A broken agent file warns only **when a run starts**. If the user never runs, they never learn their file is broken. There is no `codewhip agents validate` to check before the 2am run — the exact moment this project is named after.
- The trust certificate — the thing a team lead hands an intern — has no opinion about agents. A repo with three broken agent files and a PASS certificate is a mental model with a trapdoor.

## Gap 5 — Where the User Feels Stupid

1. **First `[explore]` line is a jump scare.** Nothing at run start says delegation is possible. The route line says `route: polish → nvidia:model`; it could as easily say `subagents: explore, review, plan available`. Instead the user learns their command spawned workers when workers appear. Visibility of system status means announcing capabilities *before* exercising them, not after.
2. **The glyph taxonomy is a secret.** `▸`, `◈`, `◆` (`src/index.ts:634`) are never explained — not in help, not in README (which prints a bare `◆` example at line 330). Users decode glyphs by trial and error, which is the definition of making people feel stupid. One legend line at first run or one row in help closes it.
3. **"Unknown agent" is a clue, not an answer.** When a broken file gets skipped, the *model* is the next speaker, and it says `delegate: unknown agent "myreviewer"`. Now the user must connect a model error to a policy glyph printed twenty lines earlier to a file they wrote an hour ago. Three facts, three speakers, zero stitching. The skip warning should carry the fix (`subagent file skipped: myreviewer.md: missing frontmatter — edit .codewhip/agents/myreviewer.md`), and ideally the tool's "unknown agent" error should list the agents that *do* exist.
4. **Task-too-long and fan-out caps surface as model-facing strings.** "split the work," "at most 4 entries" — the user's only leverage over these is hope. That's acceptable for v1, but it means the user is experience-taking orders from their own tool.

---

## Scorecard — Norman's Checks

| Check | Verdict | Why |
|---|---|---|
| Visibility of system status | **Partial** | During: `[explore]` lines yes, but silence between steps, no step/elapsed/spend counters, spawn announced after the fact. |
| Match between system and real world | **Good** | Named agents doing named work; "read-only" is enforced, not implied. |
| User control | **Fail** | Stop = kill everything. No per-child cancel, no pause, no detach, no per-child timeout. |
| Error prevention | **Good** | Depth cap ×5, pre-ladder refusals, fail-closed spec filtering. This side is over-engineered, in a good way. |
| Recognition over recall | **Fail** | Roster lives in the model's head, not the user's. No `agents` command, no run-start banner, glyph legend missing. |
| Help users recognize and recover from errors | **Partial** | Skipped-file warnings now exist (good) but lack the fix path and don't connect to the model's "unknown agent" complaint. |
| Visibility of cost | **Fail** | Meter silent during run; receipt structurally blind to per-child spend when models match; runIds unfindable in any human view. |

---

## What Closes the Mental Model (Prioritized)

**P0 — the loss bug.** Fan-out timeout must not discard finished children's reports. Return partial results with per-child status (`#1 [explore] ok (12s)`, `#2 [review] timed out`) instead of the monolithic `timed out` fallback. Paid work must never silently vanish from the conversation.

**P0 — announce, then run.** At spawn: `▸ delegating to explore (read-only, ≤10 steps, 10min cap)` before the child starts; the completion line keeps its place after. At run start (top-level only): one line listing delegable agents, so capabilities are visible before they're exercised.

**P0 — an agents CLI.** `codewhip agents list` (roster with descriptions, source: builtin/file, max_steps, model) and `codewhip agents validate` (parse every file, print errors *with the fix*). Add the roster health to `codewhip trust`. User-authored config with no inspection surface is not a feature; it's folklore.

**P1 — per-child receipt lines.** Track child runs in `LoopResult` (count, per-child runId/usage) and print, after the parent receipt: `subagents: 2 run(s), 9 tool call(s), 12k tokens (explore 7k, review 5k)`. The buckets can stay merged; the *breakdown* must exist. Also: add runId to `renderAuditEntry` so the parent-child structure is legible in `codewhip audit --replay`.

**P1 — fix the silent stretches.** Forward the child's event kind (stop flattening everything to `"tool"`), and emit a child step/heartbeat line (`[explore] step 4/10 …`) so ten minutes never looks like a hang.

**P2 — discrimination and control.** Prefix fan-out lines with an index when names repeat (`[explore#1]`); document the glyph legend once in help; explore per-child cancel (even as coarse as "SIGINT once = stop oldest child, twice = stop everything") once the accounting exists to support it.

---

## Close

The engineering beneath this feature is the best in the repo: five enforcement layers, an honest folding meter, a chain that catches every child call. But enforcement is for the auditor; *visibility* is for the user, and visibility is where this ships short. The user of a delegation feature needs to answer four questions at all times: **who is running, what are they doing, what have they spent, how do I stop them?** Today CodeWhip answers one of four during the run, two of four at the end, and hides the answer to "what was lost" entirely.

Fix the P0s and the mental model closes: *one command, a visible team, an itemized bill, a working brake.* Until then, the user who sees `[explore]` for the first time doesn't feel empowered — they feel like they walked into a room where someone was already working, and nobody told them the rules.
