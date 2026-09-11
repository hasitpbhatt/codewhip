# 07 — The five-persona committee: beating opencode/kilo, closing on Claude Code

> Convened 2026-09-11, immediately after the free-provider aggregation
> shipped (16 builtins, 4 keyless, `codewhip free` / `--free` chain).
> Question put to the committee: *what makes CodeWhip the best of the
> OpenCode/Kilo class, and on par or better than Claude Code — without
> violating a single SOUL.md ruling?*
> Evidence base: `src/` as of ab79ddf, 212 passing tests, zero runtime deps.

## The verdict in one paragraph

CodeWhip's wedge against OpenCode/Kilo is already built and they can't copy
it cheaply: **aggregated free tiers + honest $0 receipts + a hash-chained
audit trail in the same run**. The gap to Claude Code is not capability
theater — it is three concrete trust-and-session features: an **undo**
(checkpoints), a **review-before-act mode** (plan), and **sessions that
survive their own context window** (compaction). All three are harness-side,
policy-native, and flat-file. Build them in that order. Ship streaming,
subagents, and MCP never or last (kill list holds).

---

## Persona verdicts

### Naval Ravikant — leverage and specific knowledge

Everything on the roadmap must compound or it is headcount in disguise.
Look at what compounds per repo: `outcomes.jsonl`, `verdicts.jsonl`,
`remembered.jsonl`, promoted `policy.md`. Every run makes the next run
cheaper or safer *in that repo*. Nothing OpenCode ships compounds — their
state is a config file. So the criterion for every new feature: does it
write to the compounding files, or is it a rented trick?

The free chain is the adoption lever: an intern runs it with zero keys and
gets a metered, audited agent at $0. OpenCode gives you 75 providers and an
unmetered bill; we give you 16 providers where the free ones are verified,
ordered, and priced honestly. That is permissionless leverage — keep
widening it (more keyless rows as they appear), never gate it.

Cost of being wrong: building streaming or subagents first buys demo
minutes but no compounding. Reversible.

### Don Norman — the moment of panic

Design for the worst five seconds of the product: the intern watched the
agent edit six files at 2am and something looks wrong. What now? Today:
`git diff` if they're lucky, manual `git checkout` if they're not. For a
user who isn't a git expert, the product has no undo. **One command —
`codewhip rollback <runId>` — restores exactly what that run touched.**
That single command converts "terrifying autonomy" into "auditable
autonomy you can hand to a junior." Second: **plan mode**. Delegating a
task should have a review step the way edit has `ask` — show me the plan,
then let me say go. Both must be legible: print what was snapshotted, print
what a rollback restored, in plain sentences, never a wall of hashes.

Cost of being wrong: without undo, every policy win is undermined by one
bad edit experience. Users don't leave over capability; they leave over
dread.

### Steve Jobs — taste is saying no

The product is one sentence: *the agent you can hand to an intern at 2am
because everything is checked, replayable, and undoable.* Cut everything
else. Plan mode is not a feature, it's the missing half of the approval
grammar — today the grammar is allow/ask/deny per *tool call*; plan mode
makes it apply to the whole *task*. That's taste. Checkpoints are not a
feature, they're the receipt made physical. Do not add a settings page, do
not add modes people must discover: `--plan` on the run line, `rollback`
in the help, done. And no streaming until the loop is *right* — smooth
scrolling of a wrong answer is noise, not signal.

Cost of being wrong: clutter. Every half-tasted feature makes the next
denial harder.

### Linus Torvalds — boring engineering or nothing

Checkpoints are: `mkdir`, `read file`, `sha256`, append one JSONL line,
`write file` back on rollback. If you need a library for that, you've
already lost. Flat files under `.codewhip/checkpoints/<runId>/`, manifest
is JSONL like everything else in this repo, restore verifies hashes before
touching a byte, self-protect `.codewhip/**` like the memory does. Plan
mode is three lines in the policy layer: the harness already denies
per-call — a run-scoped read-only flag reuses it; if `--yolo` can bypass
plan mode, you've built neither plan mode nor yolo honestly. Compaction is
the only one with real subtlety (what do you drop, what do you never drop)
— so it goes last, designed, not rushed. No frameworks, no deps, no new
abstractions. Under 150 lines per module or justify it.

Cost of being wrong: a checkpoint system with edge-case corruption is
worse than none — restore must fail loud, never half-apply.

### Peter Thiel — what can't be copied

OpenCode can clone the free-chain table in a week. Kilo can ship a `free`
flag in a day. What they cannot ship without repudiating their own
business model: **local-first, hash-chained, signed audit of everything
the agent did, keyed to per-repo verdicts, with the meter attached.**
Claude Code will never let you swap providers, run at $0, or hand the audit
artifact to your own compliance team — their margin is token rent. So the
definitive move is to make the trust artifacts *exportable proof*:
checkpoints + rollback complete the loop (deny → allow → undo → verdict),
and every rollback deepens the moat because the trail now includes what
you *reversed*. Optimism: $0 audited agentic work for students, CI, and
small teams is a category of one. Their secret they'd never admit: they
also need undo before they trust agents — nobody has shipped it well.

Cost of being wrong: if the trust artifacts stay a demo, we're a worse
OpenCode with extra files. That's why undo ships before any capability work.

---

## Converged rulings (7, no ties)

1. **Undo ships first.** Automatic per-run file checkpoints on every
   `edit`/`write` (before-image + sha256 manifest, JSONL, self-protecting),
   and `codewhip rollback <runId-prefix> [--list]` that verifies then
   restores. Harness-side, always-on, zero deps. *(all five)*
2. **Plan mode is run-scoped policy, not a new subsystem.** `--plan` denies
   `edit`/`write`/`bash` for the whole run — above `ask`, above `--yolo` —
   and the run's output is the plan. Read/search/webfetch stay allowed.
   *(Norman, Jobs, Linus)*
3. **Compaction is designed, not defaulted.** Sessions must survive the
   context window with honest receipt lines ("compacted: N tool outputs
   dropped, transcript summarized at step S") — next slice, after undo and
   plan are boring. *(Naval, Linus)*
4. **The free chain keeps widening, keyless-first.** Every new keyless
   endpoint verified live joins the chain ahead of keyed tiers; every
   listing note stays evidence-dated. *(Naval, Thiel)*
5. **No streaming, no subagents, no MCP until compaction ships and is
   boring.** Breadth theater is the enemy (SOUL §4.5). *(Jobs, Linus)*
6. **Every commit is a verified commit.** Lint + typecheck + build + full
   test suite green before each push; receipts untouched. *(Linus, Naval)*
7. **Positioning states the class, not the parity.** README compares on
   the axis that matters: metered, audited, undoable, $0-capable vs
   capability-breadth. No "Claude Code killer" hype — SOUL voice. *(Jobs)*

## Build order (feeds `docs/roadmap.md`)

1. Checkpoints + `codewhip rollback` ← *this slice*
2. `--plan` run mode ← *this slice*
3. Transcript compaction with honest receipts
4. REPL slash commands (`/model`, `/free`) + free-chain visibility in-run
5. README comparison table (metered/audited/undoable/$0 axis)
6. Revisit: streaming only if users ask after 3–6
