# 10 — Competitive reality: where codewhip stands against Claude Code (2026-09-18)

> Triggered by the question "are we at a stage where we can compete with
> Claude Code? be as critical as you can." This is the recorded answer.
> Additive ruling; no frozen schema in this document is changed.

## Verdict

**No — codewhip cannot compete with Claude Code today, and trying to compete
head-on is the wrong goal.** The honest competitive set is the open agent
CLIs (OpenCode, Crush, Amp, Goose, Gemini CLI); the honest aspiration in
SOUL.md ("H2: credible open alternative to Claude Code's closed trust
monopoly") is a 90-day-per-slice execution problem, not a parity problem.
Feature parity vs Claude Code audits at roughly 40–50% by count, but the
skew matters more than the number: governance, auditability, receipts, and
headless/CI usage are at or above parity, while model steering, agent
benchmarking, extensibility (hooks/MCP/skills), vision, and git workflow
integration are absent or thin.

What follows is the evidence-backed gap list and what was done about it the
same day (mechanism shipped vs still open), so this file doesn't rot into
aspiration.

## The gaps, ordered by how much they matter

1. **The agent was benchmarked by nothing.** The metrics table demanded
   ≥70% polish / ≥50% implement task success while nothing measured it;
   the launch gate "PASSED" on a 12-typo run at $0.0000 — the easiest task
   class in existence — proved the meter prints, not that the agent works.
   *Mechanism shipped 2026-09-18:* `codewhip eval` — 12 fixture tasks
   (`tasks/`, 4 polish / 8 implement), machine-graded checkers, results in
   `.codewhip/eval.jsonl`, bars folded into `codewhip metrics`. The bars
   are now measurable; they still need real runs against real providers.
2. **Model steering was 22 lines.** Claude Code's behavioral quality comes
   substantially from a large hand-tuned system prompt plus harness/model
   co-design. *Partially shipped:* the system prompt grew env context,
   git conventions, delegation guidance, and an answer shape. Still thin
   relative to what competition ships; grow it eval-driven (only with a
   task-success measurement to protect against regressions).
3. **The moat had a manual crank.** "Per-repo verdicts are the only asset
   no lab can download" — but verdicts.jsonl was written only when a human
   remembered to type `codewhip verdict <id> <judgment>`. A compounding
   asset nobody feeds does not compound. *Mechanism shipped:* `codewhip
   verdict --auto <prefix>` proposes accepted/edited/reverted from
   checkpoint manifests vs the tree (git cross-check), one keypress to
   record. The judgment stays human-attached; the remembering is done for
   them. Still open: fully automatic detection without violating "audit
   senior to memory".
4. **Daily-driver gaps users feel in one session** (all still open, listed
   for the roadmap): tools execute sequentially (parallelism only via
   `delegate_many`); no prompt caching; no image input; bash bans pipes so
   git-centric chains are refused; sessions are opt-in, unnamed, off by
   default; compaction uses a flat 60k ceiling regardless of the model's
   window; no stdin prompt piping or `--output-format json`. Individually
   small; the sum reads as "noticeably worse to live in".
5. **Brand war: the trust wedge vs the free chain.** The SOUL pitch is a
   team lead letting an intern run prod-adjacent code at 2am; the growth
   hack is a 43-hop chain of anonymous community relays, several marked in
   our own registry as "never send private code". Every time the free
   chain is the headline it undermines the trust story. These coexist only
   if the free chain is explicitly the sandbox/demo on-ramp. This is a
   decision to make, not a feature to build.
6. **Distribution was pre-product.** Not on npm, clone-and-build, package
   named `codewhip-proxy` described as a "proxy library". *Shipped:* the
   package identity is fixed (`codewhip`), `prepublishOnly` gate added,
   README quickstart has the npm/npx path. Publishing remains the owner's
   manual step (npm account).
7. **Rot users would hit first** (all shipped fixed): onemin's tool-call
   template was corrupted with literal `MUN` and the test asserted the
   broken string; `src/lib/providers.ts` was a 20-provider-stale fork
   serving library consumers wrong defaults (now a Node-free shared leaf,
   `src/provider-registry.ts` + `src/free-chain.ts`, with drift-guard
   tests); dead budget/TUI code removed; TUI `/model` is live (per-turn
   switch via `takePendingSwitch`), `/free` prints in-run chain visibility.
   Also fixed same day: `read` binary sniff, `edit` CRLF-preserving
   fallback, `search` skips build trees.
8. **The wedge's UX is invisible.** The differentiator (delegation with
   audit) is a team story, but hosted shares/registry/SSO are H2 — so the
   moat's user-facing surface today is "a file path + a hash". A team lead
   cannot feel the wedge in 30 seconds. Until the team surface exists, the
   solo-dev experience (model quality × tool reliability × install) is
   what actually competes, and there we trail.

## Ruling: pick one frame for 90 days

Two axes where a solo builder can beat a lab, and only enough bandwidth to
be best-in-world at one:

- **(a) Verifiable team delegation** — the SOUL wedge. Doubles down on
  audit/delegation/receipts; requires making the moat demoable (share UX,
  one killer team demo) and eventually the H2 team features. Competes
  against nobody directly — that is its strength and its market-education
  burden.
- **(b) Honest $0 on-ramp** — students, hobbyists, CI. The free chain
  becomes the product, the trust stack becomes table stakes, and "prod"
  language leaves the pitch. Cheapest to adopt, weakest long-term moat
  (free relays are copyable), strongest distribution.

Trying to be both produced the contradiction in (5). The recommendation of
this review is (a) for 90 days — it is the only axis where the compounding
asset (verdicts, audit history, policy promotion) actually accrues — with
the free chain honestly rebranded as the demo on-ramp, never the headline.
Whichever is chosen, record it here and in `docs/roadmap.md`; the kill
list stays untouched.
