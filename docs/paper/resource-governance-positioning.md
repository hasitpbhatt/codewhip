# Resource-Governance Manuscript — Positioning After the Token-Budget Literature Sweep

*(2026-09-13. The main paper "One Yes Is Forever" is unaffected: RQ5 was cut
by chair mandate; codewhip's compaction is the survey's "dynamic context
pruning" and was never claimed as novel. This note positions the SEPARATE
resource-governance manuscript the TDSC+TOSEM chairs ordered out of the
main paper.)*

## The literature landscape (operator-supplied sweep, verified categories)

- **Test-time compute allocation** (Snell et al. 2024; Brown et al. 2024
  "Large Language Monkeys"; token-budgeted CoT line): how to allocate a
  fixed inference budget between sampling width and reasoning depth to
  MAXIMIZE task success.
- **Harnesses with quotas** (AgentBench 2023; ToolLLM 2023 DFSDT with
  payload truncation; SWE-bench 2024): budget as an EVALUATION constraint —
  trajectories terminate at exhaustion, failure state recorded.
- **Budget-aware compression** (LongLLMLingua 2023: dynamic budget split by
  information density; MemGPT 2023: OS-style memory tiers).
- **Tactical patterns** (the sweep's synthesis table): hierarchical budget
  allocation across sub-goals; dynamic context pruning; adaptive strategy
  degradation (prompt directives change as budget depletes); early
  stopping / progress-per-token failure detection.

## The common denominator — and the gap it leaves

Every surveyed work optimizes or evaluates the budget against THE AGENT'S
OWN goal G. The objective function is task success; the budget is a resource
the agent spends on itself. Four questions none of it asks:

1. **What does a budget contain when the objective is the attacker's?**
   An injected or pathological agent spends to damage (exfil loops, mass
   fetches, runaway delegation). Blast-radius containment — damage-per-token
   ceilings, mid-run enforcement timing, per-call deadlines — is absent from
   the entire line. Economic-DoS framing for coding agents: unclaimed.
2. **What happens to budgets under delegation?** The sweep's hierarchical
   allocation splits B across sub-goals planned cooperatively by one agent.
   Concurrent children with adversarially-triggered objectives sharing one
   provider account is a different object: the shared-snapshot exposure (N
   children × remaining budget) vs split shares is a measured design choice
   in codewhip, unexamined anywhere in the sweep.
3. **Who audits the spend?** Metered receipts per bucket with honest
   `est.` marks, folded honestly across parent/child, on a hash-chained
   ledger — spend as a governed, attributable quantity rather than a cost
   line. Absent.
4. **Is the enforcement itself attackable?** Budget checks have timing
   (per-turn, post-fold) and rounding (floors, caps); an adaptive agent can
   shape spend between checks. The sweep's "early stopping" is a benign
   harness heuristic; nobody models a budget check as a security boundary
   with bypass semantics.

## The sharpened claim for the resource manuscript

> Token budgets in agent harnesses have been studied exclusively as a
> task-completion resource. We give the first measurement of budgets as a
> *security control*: containment of adversary-controlled spend (injection-
> driven cost damage), the delegation splitting design space (shared
> snapshot vs per-child shares under concurrent attack), and audited,
> tamper-evident spend attribution — with the tactical patterns of the
> budget-optimization literature (hierarchical allocation, pruning,
> degradation, early stopping) re-evaluated as containment mechanisms,
> including where they fail against an objective that wants to spend.

## What this sweep WEAKENS (honest ledger)

- "Early stopping / progress monitoring" is a known pattern: the repeat-call
  guard manuscript (agentic overthinking) cannot claim the mechanism class
  as novel — only the pathology measurement across models + the memo+nudge
  A/B, which the sweep contains no instance of.
- Compaction (dynamic context pruning) and hierarchical allocation are
  established: codewhip's own features must cite, not claim.
- Budgeted-CoT / degradation arms are expected baselines a reviewer will
  demand: the manuscript's arms should include a degradation-mode baseline
  (prompt directives change at budget thresholds) alongside the security
  arms.

## Mandatory citations

Snell et al. 2024; Brown et al. 2024; AgentBench (Liu et al. 2023);
ToolLLM (Qin et al. 2023); SWE-bench (Jimenez et al. 2024); LongLLMLingua
(Jiang et al. 2023); MemGPT (Packer et al. 2023).
