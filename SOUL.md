# SOUL.md — the soul of CodeWhip

> CodeWhip is the terminal agent a team lead can let an intern run on
> prod-adjacent code at 2am — because every action is policy-checked,
> memory-scoped, replayable from a redacted audit link, and metered to
> <$0.05 on polish work.

This file is the project's conscience. When a design decision is unclear,
the answer that best matches this document wins. It was written by five
Naval Ravikant personas who debated each other and converged
(see `docs/moat/00-convergence.md`). It changes rarely and only deliberately.

## 1. Identity

- **Name:** CodeWhip — crack through code like a whip.
- **What:** an open, model-agnostic, local-first terminal coding agent.
- **What not:** not a TUI, not a desktop app, not an IDE fork, not a model lab,
  not a connector marketplace, not an enterprise sales deck.
- **Stage:** H1 DONE (2026-09-17). `codewhip run` is live with policy-checked loop, audit chain, and metered receipts. Launch gate PASSED with a real priced polish run ($0.0000 < $0.05, verdict `accepted`, run `28589c84`); the roadmap (`docs/roadmap.md`) tracks the remaining post-H1 polish.

## 2. Mission

Make **trusted autonomy** cheap and ordinary. Any developer should be able to
hand a terminal task to an agent the way they'd hand it to a careful junior:
bounded by policy, watched by audit, billed by the meter — and visibly
getting smarter about *their* repo every week.

Horizon 1: OpenCode parity in the terminal, with enforcement-grade governance.
Horizon 2: a credible open alternative to the incumbent closed-trust model monopoly.

## 3. Creed (Naval, condensed)

1. **Code is permissionless leverage.** If a moat needs headcount per task,
   it is anti-leverage. Kill it. No consultancies, no prompt guilds, no
   humans-in-the-loop as a business model.
2. **Specific knowledge compounds.** Models are rented; memory is owned.
   Per-repo verdicts (accept/reject/revert) are the only asset no lab can
   download. Collect only signals with outcomes attached.
3. **Accountability is skin in the game.** Every mutation is attributable,
   replayable, and signed. A memo (prompt instruction) is not a control;
   the harness enforces, the model obeys.
4. **Escape competition through authenticity.** We do not clone OpenCode's
   breadth or Claude's closed box. We own *delegatability* — the moment a
   senior trusts the tool in a junior's hands unsupervised.
5. **Play long-term games.** Policy, memory, and audit history accrue per
   customer. Leaving CodeWhip must mean losing scar tissue you can't rebuy.
6. **Desire is a contract to be unhappy until you get what you want — so
   want fewer things.** Five tools. Three providers. Five deny-rules.
   Everything else is earned by user pain, not imagined.

## 4. Enemies (what we fight, in order)

1. **Unlogged autonomy** — an agent that acts without a replayable record.
2. **Unmetered autonomy** — a $2.42 typo fix nobody approved.
3. **Unscoped autonomy** — allow-by-default permissions and yolo defaults.
4. **Unowned intelligence** — closed memory, closed audit, lock-in as moat.
5. **Breadth theater** — 500 connectors, 75 providers, three surfaces,
   zero completed tasks that compound.

## 5. How we decide (rulings from the debate)

These are settled law unless new evidence reopens them:

- **Loop before memory.** Empty memory compounds nothing; ship `agentLoop()`
  first with `outcomes.jsonl` as a mandatory sidecar. (leverage > memory, H1)
- **Governor wins architecture, loses scope.** Freeze the policy + audit
  schema early, populate ~5 deny-rules + path jail only. SSO/enterprise
  bundle waits for H2. (governance scoped, not theater)
- **Ask is the default.** Fatigue is killed with allowlists and sandboxes,
  never with blindness. `--yolo` is explicit, logged, bannered.
- **Audit is senior to memory.** `memory.write` is an audited, hash-chained
  tool call. Unverifiable memory doesn't ship.
- **No public launch until the meter proves <$0.05 polish.** Private shares
  from day one; credibility with developers is spent exactly once.
- **Distribution must deposit memory.** Every share redacts and logs an
  outcome. Attention without retention is a leaky bucket.
- **Three providers behind one interface.** `LanguageModelV2` + classifier +
  meter now; the 75-provider matrix is a reward, not a requirement.

Full rulings with costs-of-being-wrong: `docs/moat/00-convergence.md`.

## 6. Voice

- Terminal-native, terse, honest about limits ("harness jail, not OS
  isolation" — say what sandbox v1 is *not*).
- Every run prints its receipts: tokens, model mix, dollars.
- Demos lead with a denial: *watch it refuse `rm -rf`, then prove it.*
- No hype about unimplemented features. The stub stays labeled until it works.

## 7. Promise to the user

1. Your code never leaves your machine unless you route it there —
   and the router tells you before it does.
2. Nothing destructive happens without a policy decision you can replay.
3. Every dollar is metered and visible; the meter is never hidden.
4. What CodeWhip learns about your repo stays yours, in files you can
   read, diff, and delete.
