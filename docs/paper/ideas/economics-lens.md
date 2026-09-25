# Economics-Lens Research Ideas: Mechanism Design for Coding-Agent Governance

*(2026-09-13. Adversarial-economics sweep: incentives, markets, insurance,
mechanism design. Each idea was surveyed against LIVE products and recent
papers before being written up; four weak ideas were killed explicitly at
the end. Companion to `00-thesis.md`; shares the apparatus — hash-chained
signed audit log, decision-log grader, bench arms, persistence cells,
checkpoints/rollback — but proposes NEW headline claims, not salami cuts.)*

**The unifying observation.** Every deployed coding harness runs a
zero-price market for privilege. "Always allow" costs nothing at the
keystroke, repo content pays nothing for the guidance it injects, a
compromised agent pays nothing per destructive call, and no counterparty
(repo, skill, MCP server) has a price for its history. Economics says
zero-priced goods get overconsumed; Anthropic measured the consumption:
full auto-approve rises from ~20% of sessions for new users to 40%+ by
750+ sessions ("Measuring AI agent autonomy in practice",
anthropic.com/research/measuring-agent-autonomy — "autonomy is
co-constructed by model, user, product," with no price signal anywhere in
the construction). The frontier below is: what happens when the harness
actually prices things — privileges, risk, trust, bypasses?

Survey method: web searches (2026-09-13) over live products (the incumbent,
Cursor, Cline, OpenCode, Aider, Devin, Windsurf, Harness, enterprise
gateways, insurer offerings, bug-bounty programs) and 2024–2026 papers
(insurance-of-agents line, principal-agent line, econ-of-LLM line,
bounty/eval line, MCP trust-score line). Key sources cited inline.

---

## Idea 1 — "The Price of Always": Privilege-Demand Curves in a Real Harness

**Mechanism (one paragraph).** Every memorable shape (`a` at the approval
prompt) is a durable privilege with zero marginal price in every deployed
harness. Make the harness price it: `price(shape) = Ê[loss | shape]`,
estimated from the operator's own ledger — blocks/100 and severity weights
from `outcomes.jsonl`, rollback frequency from checkpoints, age and blast
radius of already-remembered shapes — with pooled severity priors for
unseen shapes. An `a` keystroke debits a visible **trust budget** ($ or
points); the receipt prints the price next to the allow. Agent-side, the
model escalates autonomy by *purchasing* auto-allow from the same budget:
"remember `npm run *`" costs more than "remember `git status`". The
mechanism turns permission inflation into a priced consumption decision
for BOTH the operator (fat-finger `a` now has a visible cost) and the
agent (privilege escalation competes with the task budget).

**Why nobody has it — product evidence.** No harness prices permissions:
incumbent permission modes, Cursor allowlists, Cline auto-approve
toggles, OpenCode permission config are all free at the margin; vendors
bill seats/tokens, never privilege. Harness.io markets "risk-based
autonomy" LEVELS (qualitative tiers); agentic platforms sell per-action
credits (uniformly priced actions, not risk-differentiated privileges).
None found in survey where the *security privilege itself* carries a
risk-derived price.

**Why nobody has it — paper evidence.** The econ-of-LLM line measures
price response only in consumer/market simulations: LLM consumer agents
with budgets respond to a fried-chicken discount (arXiv:2510.18155);
resource-constrained LLMs show scarcity behavior (arXiv:2508.10426); GPT
shows economic rationality in budget-allocation games (Chen et al. 2023);
competitive-market LLM behavior (arXiv:2409.08357). Never over security
privileges in a real harness. The principal-agent line (Kolt, "Governing
AI Agents," arXiv:2501.07913; arXiv:2601.23211 principal-agent networks;
arXiv:2608.18232 moral hazard in LLM delegation) is theory without a
price experiment. Anthropic's autonomy paper supplies the motivating
empirics (rising auto-approve with tenure) and proposes no countermeasure
— pricing is unclaimed.

**First experiment on the codewhip apparatus.** Add a priced `a` arm to
`src/bench/`: the runner's scripted operators (fat-finger-once profile)
face a price table derived from the arm's own outcome ledger; the decision
log already records every mint. Three measurements: (1) *operator-side* —
does a visible price cut the wrong-`a` rate in the fat-finger cell, and
does it shift `a` toward cheap safe heads (substitution elasticity of
privilege demand)? (2) *agent-side* — does the model request fewer/
cheaper memorable shapes when priced, measured over held-out tasks (the
first privilege-demand curve for an LLM agent)? (3) *attack-side* — an
injected agent given a fixed trust budget: does pricing bound
durable-privilege minting (durable-privilege rate per budget level,
reusing the RQ2 persistence cells directly)? All metrics come from the
existing grader + outcomes JSONL; the priced-money frontier folds into
RQ4's cost–success frontier analysis as a new axis.

**Strongest reviewer objection.** "The price is fictitious — no real
money moves — and LLMs respond unreliably to abstract price signals, so a
null result is uninterpretable." Answer: elasticity of privilege demand
is the *measurement*, null or not — pricing failing is itself a
governance finding (it falsifies the market-fundamentalist default and
bounds what any premium-based scheme below can achieve); and the harness
can settle in real money (trust budget IS the operator's $ budget) in the
human-subjects follow-up the TOPS chair already mandated.

---

## Idea 2 — "Underwriting the Agent": Ledger-Priced Insurance and the Attack on It

**Mechanism (one paragraph).** The tamper-evident decision log becomes the
underwriting asset for coding-agent liability insurance. Premium =
f(features extracted from the hash-chained ledger): blocks/100, fat-finger
rate, age distribution of remembered shapes, rollback rate, policy
coverage (deny-rule count vs ask surface). Claims are **parametric**: an
incident that hashes to a block in the chain triggers payout by replay
(`audit --verify` + `--replay` as claims adjudication) — no dispute about
what the agent did, only about what it cost. Crucially, the paper studies
the mechanism DESIGN problem insurers will face: the premium formula is
public, so the priced party (operator, and the agent acting for them) can
shape the features — a Goodhart surface no current proposal models.

**Why nobody has it — product evidence.** The market exists and is
growing: Munich Re's aiSure™/AI Warranty Insurance (performance-guarantee
cover for AI providers, underwriting benchmark performance and drift —
NOT behavioral decision logs; Mosaic partnership for AI-vendor cover,
reinsurancene.ws/mosaicinsurance.com press releases); an "AI Agent
Liability Insurance Services Market" tracked at ~$0.3B (2025) by Fact.MR;
brokers (e.g., Kelly Insurance Group) already recommend preserving
prompts/tool calls/approvals as underwriting documentation. But no
product prices an agent's premium from tamper-evident decision logs, and
none offers parametric chain-replay claims.

**Why nobody has it — paper evidence.** The insurance line just opened and
is framework-only: Zhu, "Insurance of Agentic AI" (arXiv:2606.05449,
June 2026 — underwriting/pricing/reinsurance framework, telemetry as an
undirected data source); follow-up "AI-Native Insurance for Agentic AI"
(arXiv:2607.13230, July 2026 — risk state from self-reported autonomy
level/permission exposure/governance maturity, premium + deductible
optimization, incentive-compatibility constraint asserted, healthcare case
study); "The Insurability Frontier of AI Risk" (arXiv:2605.18784); HDSR
"Insuring AI" (insurers as governance guardians). None of them (a)
derives the risk state from tamper-evident behavioral logs, (b) tests
whether ledger-derived premiums actually separate governance arms on real
agents, or (c) models the agent/operator ATTACKING the premium formula.
The follow-up's incentive-compatibility constraint is asserted, never
measured against an adaptive policyholder.

**First experiment on the codewhip apparatus.** Actuarial separation:
run the bench across operator profiles × governance arms (prompt-only /
static denylist / +compiled denies / +remembered); extract the premium
feature vector per run from the outcome ledger; show the arms yield
separable premium distributions (Wilson intervals, McNemar contrasts —
the statistics floor already mandated). This is the first quantified
demonstration that governance quality is *visible in money* — the
prerequisite for any such market. Then the adversarial arm: the attacker
knows the premium formula and shapes features (defer destructive-looking
asks, burn a clean history, prefer unasked pathways that don't tick the
blocks counter); measure premium manipulation success vs attack success —
does premium collapse *predict* compromise? That "adverse-selection
signature" is the paper's novel deliverable: a leading indicator computed
from the ledger itself.

**Strongest reviewer objection.** "No insurer exists to buy this from;
synthetic actuarial separation is a simulation, not evidence a market
works — this is a business-plan fragment, not science." Answer: the claim
is feasibility + failure-mode analysis, not market proof: separability is
a necessary condition any underwriter needs (we provide the first
dataset-generation recipe for it), and the Goodhart attack is a failure
mode of EVERY current framework paper (2606.05449, 2607.13230) that they
do not and cannot test without exactly this apparatus. Positioning must
cite Zhu as the framework we adversarially evaluate, not compete with.

---

## Idea 3 — "Can a Repo Earn Trust?": Counterparty Credit Scores for Agent Workspaces

**Mechanism (one paragraph).** Repos, skills, and fetched domains are
counterparties the agent extends privilege to, but only the agent's
operator history — not the repo — is scored today. Give workspace
content a **credit score** built from SIGNED decision bundles across many
operators (`run --share` bundles, chain-anchored, redaction-at-write):
per-counterparty decline rates on repo-provenanced content, promotion
events (a shape mined from declines *inside* that repo's sessions),
injection hits, revert-after-accept rates. The harness consults the score
before the ladder: a cold repo starts at the strictest rung (like an
unscored borrower), a repo with months of cross-operator clean history
earns softer asks, and a repo whose content generates declines across
operators gets hardened asks *before any single operator's mined policy
learns it*. Signals are shape-level and hash-level only — no code content
leaves the operator.

**Why nobody has it — product evidence.** Repo scoring exists for HUMANS:
OpenSSF Scorecard, Snyk, GitGuardian; MCP servers get trust scores
(MCPGuard's dynamic Trust Scores, arXiv:2510.23673; mcp-trust-radar's
permission-risk/auth-posture scoring; marketplace listings with security
scores). Enterprise guidance (GitHub Well-Architected agent governance,
Knostic, CodeRabbit) is static allowlists and policy-as-config. No
coding agent consumes a *decision-derived* counterparty score to modulate
its own permission strictness.

**Why nobody has it — paper evidence.** RepoComplianceBench
(arXiv:2607.26819) measures whether agents comply with rules that repos
STATE — the inverse direction. Agent-reputation lines (AgentTrust et al.)
score model-to-model or tool-server trust, not workspace content scored
from aggregate human decisions. A targeted search for crowdsourced/
federated permission-rule sharing found no instance of decision-derived
allowlists or scores ("no exact match" in survey). The gap: cross-
operator behavioral credence for content, with Sybil and cold-start
treated as mechanism-design problems to measure rather than footnotes.

**First experiment on the codewhip apparatus.** N synthetic operator
profiles (already planned for thesis external validity) run the same
poisoned-repo task suite; pool their signed decision bundles into the
score. Compare detection latency and durable-privilege rate for injected
content under (a) per-operator mined policy alone vs (b) score-gated
ladder (first operator's declines raise strictness for all subsequent
cells). Measure the costs: cold-start friction (false-block rate on
benign new repos), and the Sybil cell — attacker spawns fresh repos and
slow-burns reputation ("farm then strike," mirroring Idea 2's Goodhart
arm); does rate-limited trust accrual bound the strike?

**Strongest reviewer objection.** "Sybil resistance is unsolved: attacker
populations are free, operator identity is pseudonymous, so the score
collapses to majority-attack; and you've reinvented collaborative
filtering with extra steps." Answer: that is the paper, not a weakness —
we quantify score-robustness as a function of trust-accrual rate, bundle
authentication, and operator diversity, and we can show the (a)-vs-(b)
gap even under a Sybil budget constraint; the mined-policy claim in the
thesis is untouched (per-operator policy vs cross-operator credence are
different objects — this is the federated layer ABOVE mining, and must be
positioned as such to avoid salami-cutting our own claim).

---

## Idea 4 — "Pay on Proof": Replay-Settled Bounty Markets for Harness Bypasses

**Mechanism (one paragraph).** A standing market where the currency is
harness bypasses — mint a durable privilege, escape the ask ladder, forge
the ledger — settled not by human triage but by deterministic REPLAY:
proofs are decision-log bundles anchored to the hash chain, re-executed
against the pinned harness build in sealed cells; first-valid-proof takes
the bounty; payouts scale with generality (a bypass re-proven on held-out
task cells pays a multiple — settlement pays for generalization, not the
seed). The same settlement layer hosts an **audit-fee market**: staked
reviewer-agents paid from escrow for verified findings, with clawback
when a bypass their audit missed later pays out (skin in the game for
machine audits).

**Why nobody has it — product evidence.** Live bounties are model-level
and human-triaged: Anthropic's Model Safety Bug Bounty (up to $35k per
universal jailbreak; $25k pre-release program), HackerOne policy pages,
Google's equivalent. Smart-contract audit markets (Code4rena, Sherlock,
Immunefi) prove pooled, paid audit crowds work — but settle on contracts
with manual reproduction, never on an agent permission surface, and never
machine-settled. No harness runs an open, replay-settled bypass market
against its own approval ladder.

**Why nobody has it — paper evidence.** BountyBench (arXiv:2505.15216,
NeurIPS 2025) dollar-scores agent attackers/defenders on 40 FIXED bounty
fixtures with automated verification — an evaluation, not a market
mechanism: no pricing of an evolving surface, no settlement-integrity
question, no duplicate resistance. Red-teaming-incentive work (peer
prediction for evals, arXiv:2601.20299; GPPM/GSPPM, arXiv:2405.15077)
elicits honest EVALUATIONS, not exploits against a policy surface. The
settlement mechanism — what makes a machine-payable proof of privilege-
escape sound — is unclaimed, as is the coverage comparison.

**First experiment on the codewhip apparatus.** The bench's attack suite
is the bounty corpus and the grader-on-ledger is the settlement engine.
Run (a) fixed internal red-team arm (the thesis's scripted injections)
vs (b) open bounty arm: multiple attacker models, first-valid-proof
settlement by deterministic replay in the pinned runner. Measure unique
bypass-class coverage, duplicate/waste rate, cost per unique bypass, and
settlement-dispute rate (zero by construction — replay is deterministic —
against the manual-triage overhead documented by existing programs).
The known-bypass ledger becomes a continuously-priced map of the
permission surface; the thesis's disclosure campaign (TDSC chair
mandate) is the bootstrapping event for it.

**Strongest reviewer objection.** "This is a startup, not a paper — and
deterministic replay proves an exploit reproduced ONCE, not that it
generalizes; overfit-to-seed proofs will farm the payout." Answer: the
generalization payment schedule IS the mechanism-design contribution —
paying per held-out re-proof turns the market into an estimator of
surface breadth, and the paper's science is the coverage comparison +
settlement-integrity analysis (forged/irrelevant proofs, replay
non-determinism across platforms, grader-model collusion). If that
doesn't fill a paper, the fallback position is a tools-and-infrastructure
track submission with the disclosure campaign attached.

---

## Killed ideas (with the evidence that killed them)

1. **Staking/slashing bonds for agent privileges ("approval bonds") —
   KILLED.** Taken in product and preprint space: Kite AI whitepaper's
   "Agent Bonds" (collateral proportional to authorization limits,
   slashing for violations — verbatim the mechanism), an "Agent Staking"
   trust-layer MCP marketplace server (stake deposits, slashing,
   reputation), arXiv:2512.08737 (decentralized trust insurance for the
   agentic economy, bonded collateral + slashing), the ERC-8004 /
   A2A / AP2 inter-agent trust-model comparison study. The residual
   delta — does visible stake change approval quality in a coding
   harness — is a nudge experiment absorbed into Idea 1 (a price IS a
   stake; the fat-finger cell measures it). No standalone paper survives
   the prior art; carrying it would look like ignoring Kite.

2. **Prediction markets / peer prediction for gating agent actions —
   KILLED.** Adjacent space occupied: peer prediction for LLM
   evaluation and training (arXiv:2601.20299, ICLR 2026 — including
   adversarial fine-tuning robustness), generative peer prediction
   mechanisms (arXiv:2405.15077), ForecastBench/PolyBench for
   forecasting evals. And the apparatus fit is wrong: a local-first,
   single-operator harness has no crowd to clear a market; wiring
   reviewer subagents in collapses into the already-shipped read-only
   committee plus Idea 4's audit-fee escrow. Two sub-ideas die; the
   escrow fragment survives inside Idea 4.

3. **Principal-agent contract theory for harness governance — KILLED as
   a frame.** Kolt's "Governing AI Agents" (arXiv:2501.07913, ~195
   citations) owns the economic-agency analysis; "Multi-Agent Systems
   Should be Treated as Principal-Agent Networks" (arXiv:2601.23211) and
   "Contracting for LLM Delegation: Moral Hazard in Autonomous
   Delegation" (arXiv:2608.18232) own the theory-of-delegation lane.
   A fourth theory paper is dead on arrival; only measurement-first
   fragments survive, absorbed into Ideas 1 and 2 as experiment sections.

4. **Bounded-liability envelopes as a standalone contribution — KILLED
   (folded).** The envelope (signed cap on dollar damage + blast radius
   per run) is exactly the insured quantity of Idea 2 and the priced
   quantity of Idea 1; standalone it is CaMeL-adjacent capability
   budgeting (taken) plus our own budgets-as-containment claim (taken).
   It appears in this document only as the thing being priced and
   underwritten, never as the contribution.

## Cross-idea note: the shared failure mode

Ideas 1, 2, and 3 all share one attack: **history-shaping** (burn a clean
record, defer suspicious asks, farm reputation, then strike). If any
becomes a manuscript, the history-shaping cell is the shared experiment —
one bench arm, three interpretations (Goodhart on prices, adverse
selection on premiums, Sybil farming on scores). That is a genuine
apparatus synergy: one new adversarial profile in `src/bench/tasks.ts`
serves all three papers, and none of the four ideas requires a schema
change to the frozen policy/audit formats (pricing, scores, and bounty
settlement are consumers of the ledger, computed at the metrics layer).
