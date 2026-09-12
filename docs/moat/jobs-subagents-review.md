# Steve Jobs Review: Subagents & Delegation

**Date:** 2026-09-12
**Scope:** commits `b16dd96` + `396fc56` — `src/subagents.ts`, `src/tools/delegate.ts`, `src/tools/delegate_many.ts`, README "Subagents", `--plan` banner
**Verdict:** The fence has no holes. The front door has no sign. Ship the sign.

---

## The One-Sentence Verdict

You built the committee, made it read-only, put it on the audit chain, and taught it to survive a 429 — that's the hard part, done right — but the moment a user writes their first custom agent, your product goes *silent* about whether it worked. Fix the silence and this stops being a feature and becomes a habit.

---

## What's Right (Credit, Fast)

**1. Three built-ins, zero-config. The default is the product.**
`explore`, `review`, `plan` — before the user reads a single doc, the model can already investigate, attack, and plan. Nobody had to configure anything. Most teams would have shipped an empty registry and a tutorial. You shipped value.

**2. Flat frontmatter + body = system prompt. Saying no to a config format.**
One markdown file. `description/model/max_steps` up top, prompt below, done. No YAML nesting, no schema files, no wizard. The description is *required* (1..200) because that's what routes the parent's choice — you understood that the config exists for the router, not for the user's ego. That is taste.

**3. The trust model didn't blink.**
Children: plan-mode refusals pre-ladder, `yolo: false`, no TTY prompting, depth cap 1 enforced twice (specs filtered at construction *and* a fail-closed guard in the loop for rogue calls). Every child call on the hash chain under its own runId, its own outcome record, `parent_run_id` linking. A delegation feature that grants zero authority is the only delegation feature worth shipping in this repo. You didn't dilute the moat to add a checkbox.

**4. `[explore] ...` streaming — you can watch the committee without hearing its meetings.**
Progress lines prefixed per agent, interleaved readably, while the parent's context receives *only the final report*. That last part is the difference between a tool and a toy: most delegation implementations dump the child transcript into the parent's context and call it "visibility". You gave the human visibility and the model a summary. Correct.

**5. The plumbing nobody sees but everybody would feel.**
Rotation and `--retry-wait` inherited so a fan-out rotates instead of dying on a rate limit. And the detail that proves someone actually thought: rotation is **not** forwarded when a custom agent overrides the model — a per-agent model rides a different id space, so candidates would mis-rotate onto the wrong family. That's the kind of correctness that never demos well and always fails loudly in month three. It won't.

**6. Every cap has a sentence.**
8000-char prompt body (the compactor can't prune system messages — a runaway prompt is a cost amplifier), `max_steps` ≤ 25, fanout ≤ 4, task ≤ 8000 chars, one child default 10 steps. No magic numbers without a reason in a comment. This is disciplined.

**7. `--plan` refuses delegation, not just mutation.**
A read-only run spawns no readers-of-the-reader. The banner says so out loud (`!! --plan armed ... edit/write/bash/delegate denied`), the refusal is pre-ladder so `--yolo` can't grant it, and it lands on the audit trail as `deny:plan:read-only`. Consistent from policy to pixels.

---

## The Friction (Be Brutal)

**1. Custom agents die silently. This is the worst moment in the feature.**
`parseAgentFile` returns precise, human-readable errors — "description required (1..200 chars)", "frontmatter not closed". Beautiful errors. Then `listAgents` throws them away: any file that fails to parse is *skipped, silently*. You write your first custom agent — the moment of maximum emotional investment in this feature — typo one frontmatter line, and your agent simply doesn't exist. No warning at startup. No `codewhip agents` command to see what loaded. The only signal is the model later reporting `delegate: unknown agent "my-agent"`, which the user will read as "the tool is broken", not "my file has a typo".

A user should never have to debug silence. Print `skipped .codewhip/agents/foo.md: description required` at run start, or ship a list command. This is a twenty-line fix and it is the difference between a feature and a product.

**2. The committee's budget is metered honestly and enforced approximately.**
`delegate_many` hands *all four* children the same snapshot of the parent's remaining budget (`loop.ts` computes it once per tool call; there is no shared decrementing counter). For one child, "enforced live, not just metered" is true. For the committee you advertise in the README, four children can each burn up to the full remainder before the parent's folded check trips — up to 4x overshoot. The README sentence is therefore half true on the exact case the feature is named after. Share one counter across the fan-out. Don't let the marketing sentence and the code disagree.

**3. `--help` and the banner disagree about the same flag.**
`--help` line: `--plan  read-only run: edit/write/bash denied...`. The banner: `edit/write/bash/delegate denied`. The banner is right; help is stale. One word, but the whole point of `--plan` is that nothing can sneak authority past it — the user's first reference document should know the full list.

**4. `delegate_many` validation fails one error at a time.**
Two unknown agent names in one call → the parent fixes the first, re-calls, hits the second. Collect every validation failure and report them together. Fail fast, but fail *completely*.

**5. Dead code in an otherwise tight file.**
`delegate_many.ts`: `args.entries.slice(0, MAX_FANOUT)` immediately followed by a rejection when `args.entries.length > MAX_FANOUT`. The slice can never matter. Two lines later the same file hand-rolls an error per entry. Sloppiness is a habit; don't let it start here.

**6. Custom agents are invisible until the model uses them.**
The roster exists only in the system prompt the model sees. The human never sees `agents: explore, review, plan + 2 from .codewhip/agents/`. One banner line at run start closes the loop between "I wrote a file" and "the system knows my file". Same fix as #1 — visibility, once.

---

## What I'd Cut or Push Back On

**Nothing structural.** The caps are right. Depth 1 is right — recursion is a research project, not a feature. The `[subagent explore runId: ...]` tail on reports looks like noise until you cross-reference it against the outcome record for rollback or an audit question; keep it. I'd argue with anyone who wants to add per-agent tool overrides, child mutation rights, or depth 2. Every one of those adds a config surface and a trust hole in exchange for a demo. Say no. This feature says no to the right things; that's rare and it's why it fits this repo.

---

## The Bar to Clear

1. Surface skipped-agent-file errors at run start (or `codewhip agents`). The silence is the product defect; everything else is polish.
2. One shared budget counter across a `delegate_many` fan-out.
3. `--help` mentions `delegate` in the `--plan` line; collect all `delegate_many` validation errors; delete the dead `slice`.

Then the story is: *three agents on day zero, your own in one markdown file, watchable, auditable, rollback-able, and it survives a rate-limited provider.* That sentence sells. Right now the sentence has an asterisk the size of a silent skip. Remove the asterisk.

**Ship the sign. The fence is done.**
