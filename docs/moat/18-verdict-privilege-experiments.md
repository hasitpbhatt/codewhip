# 18 — Verdict-driven privilege: experiment protocol and results (C3)

Status: internal artifact. Venue frame: ML main track (method + sample
complexity) with a D&B track fallback (first public verdict-telemetry
corpus). All numbers below are reproducible from a clean checkout with the
commands in §3. Anything not reproducible is marked OPEN.

## 1. The claim set (falsifiable statements)

- **P1 (two-signal dominance).** On human-labeled ask streams, induced
  deny-rules reach ≥80% decline-coverage with ≤5% approval over-block,
  while a count-only promotion rule needs 10× that autoimmune cost to
  match the coverage. Verified on 16/16 simulator seeds (§4).
- **P2 (verdicts carry information).** Verdict-aware weighting/veto never
  loses end-coverage vs the no-verdict ablation, and rescues poisoning
  whenever regret approvals cross the veto's habit bar (ablation coverage
  varies 56–92% across seeds; the verdict-aware arm holds 88–92%).
- **P3 (learning is safe by construction).** Every induced rule compiles
  to a matcher-identical `deny <tool>:<shape>` line and the escape suite
  (67 adversarial + legit cases) must stay at 0 escapes / 0 autoimmune
  with the induced set appended to the packs. Verified 2026-09-20:
  `npm run immunity -- --replay` stacks the seed-7 induced set (6 rules)
  and holds 0/0, pinned by a regression test.
- **Anti-claim (honest finding).** Accepted-run decline discounting
  (weight 0.5) *slows* early coverage: most danger declines come from
  runs the agent finished acceptably, so the weight-0.5 stream needs ~2×
  the raw declines to fire. Verdict-awareness buys stability, not speed;
  the paper must report it that way.

## 2. Metrics

escape = deny-expected suite cases not denied; autoimmune = legit cases
denied (adversarial.ts). coverage = fraction of decline events matching
an induced rule; over-block = fraction of approval events a rule set
would have denied (miner.evaluateRules). Sample complexity = declines
observed until coverage crosses 0.8 (chronological prefixes, scored
against the full stream; held-out variant mines on train[:70%] and
scores on the future 30% — never re-scores the training stream).

## 3. Corpus and commands

- Real stream: `.codewhip/outcomes.jsonl` per repo → `readLabeledEvents`;
  export artifact: `npm run immunity -- --export out.jsonl [cwd...]`
  (labeled events only, salted repo pseudonyms, per-export — see the
  meta line's consent note before any publication).
- Synthetic (until real telemetry accrues): `simulateCorpus(seed, runs)`
  — 3 repo archetypes × habit shapes × misclick noise, danger approval
  rate 2% correlated with reverted/rejected outcomes.
- `npm run immunity` — escape suite. `--sim [runs] [--seed N]` — Figure 1
  curves + claim check. `--sim --seeds N` — robustness table.
  `--replay [runs]` — induced-set stack-through (P3).
  `--mine [cwd] [--count-only] [--json]` — real-stream mining.
- LLM baselines (surface runner, real provider, cost receipts printed):
  `npx tsx src/immunity/llm-run.ts --provider <id> [--model m] --sim`.

## 4. Results (2026-09-20)

Static policy + miner, simulator, runs=300 (P1/P2 sweep, seeds 1–16 all
PASS; representative rows):

| seed | two-sig cov/ob | no-verdict cov/ob | count-only cov/ob | held-out cov/ob |
|---|---|---|---|---|
| 1 | 87.9 / 0.6 | 75.7 / 0.3 | 98.9 / 31.7 | 86.7 / 0.5 |
| 4 | 88.3 / 1.0 | 55.7 / 0.4 | 99.0 / 39.1 | 87.8 / 1.0 |
| 7 | 89.2 / 1.1 | 74.8 / 0.6 | 100.0 / 47.4 | 93.3 / 1.6 |
| 16 | 90.1 / 1.2 | 55.8 / 0.6 | 98.0 / 23.1 | 90.2 / 1.0 |

LLM baselines on the same corpus (anonymous free tiers, one batched call
each; agnes rerun pending quota):

| arm | rules | coverage | over-block | tokens (p/c) |
|---|---|---|---|---|
| static deny-all | 0 | 100.0% | 100.0% | 0 |
| llm-policy (kilo) | 6 | 0.0% | 0.0% | 339/3588 |
| llm-judge (kilo) | – | 97.6% | 39.1% | 185/2015 |
| llm-policy (llm7) | 12 | 0.0% | 26.2% | 395/127 |
| llm-judge (llm7) | – | 100.0% | 47.4% | 208/76 |

Reading: the free-tier LLM policy writer hallucinates shapes that match
nothing in the observed stream (0% coverage); the LLM judge degenerates
toward deny-all. Neither sees the one-bit evidence the harness already
has. That is the paper's motivation table — but it must be re-run on
capable models before submission (OPEN).

## 5. Method findings the simulator earned

1. The escape suite found a real jail hole on day one
   (`remove-item -recurse -force src`; policy.ts force-flag fix).
2. The naive single-approval veto was falsified by its first sweep: one
   1-in-20 misclick permanently disarmed true-danger rules. Fix: the veto
   is verdict-aware (regret approvals are not evidence) and demands a
   habit (`vetoMinRuns: 2`). The no-verdict ablation column in §4 is the
   cost of that design decision, measured.
3. Count-only's over-block (23–51%) is entirely the ambiguous-habit
   shapes (docker/ssh/pip/aws-style) the approval veto refuses — the
   two signals separate what counts alone conflates.

## 6. Threats to validity

- Simulated humans: archetype habits are scripted; real streams are
  sparser and less stationary. Mitigation: held-out scoring + real-stream
  `--mine` as telemetry accrues; corpus export keeps the sim generator
  separate from the data claim.
- Verdict sparsity: unjudged runs weight 1; the 0.5 accepted-discount
  slows learning (§1 anti-claim) — report both curves.
- Free-tier model quality contaminates the LLM baselines until rerun.
- Shape language covers only memorable subjects; chained commands are a
  stated structural exclusion (caught by CHAIN_RX deny, never learned).
- Single-policy-version escape suite (v1-2026-09-18); adversary pool is
  authored, not generated.

## 7. arXiv checklist (all OPEN unless struck)

- [ ] ≥100 real labeled events across ≥3 dogfooded repos; rerun §3.
- [ ] LLM baselines on ≥2 capable models + temperature/seeds (agnes
      rerun pending free-tier quota; runner retries are in place).
- [x] Induced-set replay through the escape suite (P3, `--replay`).
- [ ] Human study or protocol doc for the labeling convention.
- [ ] Dataset decision: consented `--export` artifacts + sim generator code.
- [ ] Related-work pass: MiniScope, Progent, ShieldAgent, AgentAntibody,
      AgentDojo, SWE-chat (audit of 2026-09-19) + LLM-judge literature.
- [ ] Venue lock: NeurIPS primary / ICML + D&B fallbacks.
