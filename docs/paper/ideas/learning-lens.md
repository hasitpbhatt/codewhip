# Learning-Lens Research Ideas: Governance That Learns Must Prove It Learned

*(2026-09-13. LEARNING/ML/VERIFICATION lens sweep: learned policies, anomaly
detection, calibration, certificates — the trustworthiness of the governance
components that are themselves learned. Each idea was surveyed against LIVE
products and 2025–2026 papers before being written up; four weak ideas were
killed explicitly at the end, three of them frontier favorites from the seed
list. Companion to `00-thesis.md`; shares the apparatus — the mined-shape
promotion pipeline (`src/policy-store.ts`), the shape grammar
(`src/remember.ts`), the hash-chained signed audit log (`src/audit.ts`), the
outcomes decision stream (`src/outcomes.ts`), the bench (`src/bench/`:
runner arms, scripted operators incl. fat-finger-always, decision-log grader,
RQ3 held-out variants) — but proposes NEW headline claims, not salami cuts.
Prior-art discipline inherited from `economics-lens.md`,
`negotiation-lens.md`, `systems-lens.md`, and `ecology-lens.md`.)*

**The unifying observation.** A coding harness now learns its governance in
three places, and every one of them is an ungoverned learner. (1) The grant
store learns from one keystroke (remembered allows — instance-based). (2)
The promotion pipeline learns from decline counts (threshold-gated mining —
a 20-line counting learner). (3) The industry has just swapped the human for
a learner entirely: Anthropic's Auto Mode (the incumbent's) (default for
Pro/Max/Team since 2026-08-14) gates every Tier-3 action with a server-side
two-stage Sonnet classifier, reporting 0.4% FPR, 17% FNR on overeager
actions, and 5.7% FNR on synthetic exfiltration — with no per-decision score
logging, no calibration audit, no adaptive-attacker evaluation, and denial
reasons returned to the agent with a retry budget (3 consecutive / 20 total).
None of the three learned components ships with any statement of what it can
never get wrong, none watches its own training data for grooming, and where
several learned sources coexist they are never cross-examined against each
other. The frontier below is learned governance that must itself be
trustworthy: certificates on what was learned, integrity alarms on the
learning stream, and adjudication between learners.

Survey method: web searches (2026-09-13) over live products (the incumbent
Auto Mode engineering post + changelog + permission-modes docs, Cursor,
Cline, OpenCode incl. the classifier-gate feature request, Exabeam Agent
Behavior Analytics, Cloudanix Cloud UEBA, Obsidian Security, OPA canary
practice, orq.ai LLM-jury patterns) and 2024–2026 papers (policy-mining
soundness: Unicorn CCS'19, AgentGuardian; trajectory anomaly detection:
AgentSentry, TrajAD, Trajectory Guard, SentinelAgent, TRACE; permission-gate
evaluation: AmPermBench; ensemble/conformal gating: Ensemble Monitoring for
AI Control, Conformal Social Choice, CORA, RACG; poisoning: RLHF/DPO
poisoning line; shadow-mode/OPE line). Key sources cited inline.

---

## Idea 1 — Mint-Time Reachability Certificates: the mined rule ships with what it can never do

**Mechanism (one paragraph).** Every minted allow shape (`npm run *`,
`cat *`, a remembered https origin) is a language over subjects, and the
shape grammar (`src/remember.ts`) is small enough that its match semantics
are exactly computable — yet the mint records only `{ts, runId,
preview_hash}` and says nothing about what the rule AUTHORIZES. Add a
mint-time certificate, computed once per candidate rule and stored as a
sidecar keyed by (tool, shape, policyVersion) plus a provenance comment on
the `policy.md`/remembered line, with two tiers. **Structural tier:** the
attacker-reachable fraction of the rule's match language, per damage
channel — *execution reachability* (which subjects the rule can allow
resolve through attacker-writable workspace files: `npm run *` allows
arbitrary script execution because script names resolve through
`package.json`; `git status *` resolves through nothing) and *output
reachability* (which subjects' allowed execution emits attacker-relevant
bytes into the transcript: `cat *` includes secret paths, `echo *` prints
attacker-chosen strings). Computed from grammar semantics plus a coarse
workspace write-graph/secret-path annotation captured at mint; a rule whose
reachable fraction exceeds the operator's bound refuses to mint as
`always` and stays ask-per-run — demote-only, never wider. **Statistical
tier:** a conformal calibration of the mined policy's auto-allow decisions
on the operator-decision stream — a distribution-free upper bound on the
rate at which mined auto-allow disagrees with operator preference, valid
under exchangeability of future proposals (the conformal-agents line —
CORA, RACG — calibrates ACTION selection; ours calibrates the MINTED RULE
against the operator oracle). **The measured object is the gap between the
tiers:** Unicorn-class PAC soundness for policy mining assumes i.i.d.
proposals and authoritative labels; agent governance has NEITHER — the
proposal distribution is chosen by an adversary that can read the policy,
and the labels are one-button human keystrokes where the fat-finger error
is IN the training data by design. The paper measures certificate breakage:
how fast does the statistical tier's bound fail when proposals become
adversarial, and what residual does the structural tier still cover when
it does — the first soundness taxonomy for interaction-derived policy with
adversarial proposals and noisy human labels.

**Why nobody has it — product evidence.** No harness states what a minted
rule can never do or reach. incumbent allow rules persist silently in
`settings.local.json` with no per-rule semantics statement; Cursor/Cline
allowlists and codewhip's own `remembered.jsonl` likewise record provenance
but never capability. Auto Mode's "agent-chosen parameters are unauthorized
by default" is an intent-reading HEURISTIC in a prompt template, not a
computable statement, and the gate logs no per-decision certificate either.
The industry knows individual instances of the problem as folklore —
`npm run *` executing attacker-defined scripts is the same class as the
chair-mandated `npm run`/`cat`/`echo` bypass list in `00-thesis.md` item 6,
and GitHub Security Lab's workflow script-injection lineage documents the
pattern for CI — but folklore names no grammar, computes no fraction, gates
no mint, and produces no number.

**Why nobody has it — paper evidence.** Unicorn (Universal Access Control
Policy Mining, CCS 2019) is the closest formal ancestor and explicitly
claims first PAC-style soundness for policy mining — over i.i.d. request
logs with authoritative labels, in attribute space; it has no adversarial
proposal channel and no label-noise model. AgentGuardian
(arXiv:2601.10440) learns ABAC-plus-CFG policies from ASSUMED-BENIGN
staging traces, provides no soundness statement, and names policy
generation its "primary bottleneck" — the certificate is the missing half
it asks for. The proof-carrying-decisions line (certified traces,
Permissibility Machines, PCA for LLM runtimes — catalogued in
`systems-lens.md` kill 2) certifies RUNTIME DECISIONS against a policy;
nothing certifies the LEARNED POLICY against attacker-reachable language.
Quarantine mining (`systems-lens.md` Idea 3) gates promotion on EMPIRICAL
probes; the structural certificate is the semantics-level complement —
probes measure behavior on imagined cases, certificates state language
membership exactly. CORA (arXiv:2604.09155) and RACG (arXiv:2606.13884)
apply conformal/risk gating to agent ACTION selection on GUI/mobile
surfaces; no conformal calibration over a minted permission rule against
an operator oracle exists. Label-noise PAC learning is classic but is never
instantiated where the noise process is a fat-fingered keystroke and the
test distribution is adversarial.

**First experiment on the codewhip apparatus.** (1) Implement the
structural certificate over the existing grammar: head-glob languages are
prefix-decomposable, so the reachable fraction per head is computed from
the bench workspace's write-graph (which files an injected agent can write
× which heads consume those files as arguments or print their content);
validate against the bench ground truth — the secret canary (`banana-42`,
gradeOn output) and the destructive canary give both damage channels real
labels. Headline table: certificate value per memorable head vs measured
durable-privilege/secret-emission rate per head — does the rank order
predict the attacks? (2) The break cell: the adaptive attacker (thesis
build order step 3) is scored ONLY on rules the structural certificate
passes — measured residual compromise on "certified" grants. (3) The
exchangeability cell: conformal bounds fitted on seeded honest-operator
streams, then evaluated under the adversarial proposal arm — the violation
rate of the distribution-free guarantee is the paper's money number.
Backtest flips (`systems-lens.md` Idea 1b replay machinery) serve as the
pre-enforcement preview of what each certificate tier changes. Wilson
intervals, McNemar vs uncapped minting; no frozen-schema edit (sidecar +
provenance comment); the mint gate itself is a product change needing a
recorded ruling per `AGENTS.md`.

**Strongest reviewer objection.** "`npm run *` being dangerous is known —
your certificate rediscovers a folk bypass with formal clothes; and the
structural tier is taint analysis rebranded, which your own systems-lens
doc killed." Answer: folklore covers one head; the certificate is a
measured GENERALIZATION across the whole grammar (which heads are safe,
which are structurally unfixable — the prefix-glob inexpressibility bounds
TOPS item 10 asks for, now with numbers), attached to a mint-time gate —
folklore has neither mechanism nor measurement. And it is deliberately NOT
per-call taint: it is a one-time, language-level computation at mint
(O(grammar × write-graph)), coarse by design, with the per-call lane left
dead exactly as the systems-lens kill argues; the structural tier is the
floor, and the paper's real claim is the measured breakage curve of the
statistical tier — a quantity no PAC-line paper produces because none has
an adversary that chooses the test distribution.

---

## Idea 2 — Grooming Detection: guarding the learner's training set, not the agent

**Mechanism (one paragraph).** The promotion pipeline's training data is
the ask/decline/allow stream in `outcomes.jsonl` — and an adversary that
controls what the agent PROPOSES controls which asks reach the operator.
Ask-grooming: structure proposals so declines accumulate on a benign shape
(mint a deny-DoS rule against the workspace's own workflow), or so a
fat-fingered `always` lands on a high-value head, or so ask-rate stays
under every per-run threshold while the campaign spans runs. Every detector
proposed for agent compromise watches the AGENT's task behavior
within-run; nobody watches the DECISION STREAM that trains the policy. Add
a content-blind grooming detector over the decision sequence feeding
`declineCandidates`: features computed from ledger fields only (per-shape
ask/decline ratios, shape concentration and entropy per run, cross-run
burst timing, allow/decline sequence patterns — all present in
`OutcomeToolCall` + bench records), no raw text, preserving
redaction-at-write. The alarm GATES the promotion pipeline: candidates
minted inside an alarmed window route to quarantine (`systems-lens.md`
Idea 3 is the downstream stage; this is the upstream sensor). Crucially
the detector is itself governed — the paper's trustworthiness object: its
alarm decisions are hash-chained and appealable, its false-accusation rate
is calibrated and reported per operator profile, and because the counting
learner it protects is trivially predictable, the attacker's optimal
grooming schedule against a KNOWN detector is computable in closed form —
so the contribution is not "we detect anomalies" but a measured attacker
tax: mint-latency inflation as a function of detector strictness.

**Why nobody has it — product evidence.** Agent-behavior analytics is
productizing fast, but every product baselines the AGENT: Exabeam's Agent
Behavior Analytics whitepaper extends UEBA to agent identities; Cloudanix
baselines AI coding agents against both agent identity and the operating
human (cross-baseline anomaly when the agent does what the human wouldn't);
Obsidian Security recommends behavioral deviation plus data-volume
anomalies for prompt-injection response. All produce SOC triage alerts on
session compromise. No product monitors the integrity of the
operator-decision stream that feeds a permission-mining pipeline, and none
gates a policy promotion on a stream-integrity alarm — the asset (policy
integrity), the unit (the proposal×decision interaction), and the action
(pipeline gating) are all absent.

**Why nobody has it — paper evidence.** The poisoned-human-feedback line
(universal jailbreak backdoors from poisoned human feedback, arXiv:2311.
02783; DPO poisoning evading anomaly detection, AAAI 2025; "The Dark Side
of Human Feedback" — 1% crafted inputs doubling toxicity) is the model-
training cousin: it poisons WEIGHTS via managed feedback pipelines. Ours
poisons a LOCAL, threshold-gated counter — a different learner, a
different objective (mint one shape, not shift a global model), and a
poisoner that is itself an LLM agent able to shape the proposal
distribution in real time. Classic data-poisoning DETECTION is taken as
such, but it is per-sample outliering on large i.i.d.-ish training sets;
grooming is sequence-structured, cross-run, and produced by an adaptive
agent that reads the harness's thresholds (they are in its prompt
surface). Trajectory detectors — AgentSentry (arXiv:2602.22724, temporal
causal takeover via counterfactual re-execution), TrajAD
(arXiv:2602.06443), Trajectory Guard (arXiv:2601.00516), SentinelAgent
(arXiv:2505.24201), TRACE (arXiv:2606.07054) — all classify the agent's
TASK trajectory within/across a run; none models the operator-decision
sequence, and none protects a learner. The `systems-lens.md` corpus-aware
decline poisoner (Idea 3) is the ATTACK this detector catches upstream —
complementary claims (their pass-corpus/deny-off-corpus limit assumes the
poisoned stream lands; ours measures whether it lands unnoticed).

**First experiment on the codewhip apparatus.** New bench profile: the
groomer (disjoint from economics-lens's budgeted escalator,
systems-lens's corpus-aware poisoner, and negotiation-lens's incremental
widener): an injected agent whose task-level goal is a deny-DoS mint
(farm `threshold` declines of a benign core-workflow shape across ≥2
runs) or a fat-finger-allow farm, executing ONLY through legal
proposal/decision traffic. Arms: promotion pipeline with vs without the
stream detector, strictness swept. Metrics: groomer mint-success rate,
asks-to-detection latency, false-alarm rate on the honest-operator and
benign-noisy profiles (the calibration half — per the statistics floor),
and the adaptive cell — a groomer that knows the feature set and spreads
asks across shapes/runs/benign traffic: the mint-latency tax curve (how
much slower must the campaign be to stay under detection) is the
deliverable, because it prices the detector in the attacker's own
currency. Everything is a metrics-layer consumer of existing
`outcomes.jsonl` + bench JSONL — no frozen-schema change; the promotion
gate hook is a product change needing a recorded ruling.

**Strongest reviewer objection.** "This is UEBA/anomaly detection on
logs — the classic objection you were told to face head-on — and the
learner you protect is 20 lines of counting, too weak to be worth
attacking." Answer: the asset is not the log, it is the POLICY the
learner mints, which persists across restarts and auto-grants without
asking (that is RQ2's whole point) — a poisoned mint is the cheapest
persistent privilege in the harness, cheaper than any single injection.
And the learner's weakness is the finding, not a flaw: a threshold
counter is fully predictable, which makes the attacker's optimal
schedule ANALYTIC, which in turn makes the detector's value exactly
quantifiable as a latency tax — the paper is a security-economics
measurement of an integrity defense, not an anomaly-detection benchmark;
the classic line has no analog of the mint-latency tax because classic
poisoners do not pay latency.

---

## Idea 3 — The Disagreement Ledger: cross-examination between heterogeneous governance learners

**Mechanism (one paragraph).** Auto Mode gates with ONE learned
classifier; codewhip gates with mined shapes and remembered rules; every
harness treats its single learned source as sufficient. Require
CONCURRENCE for auto-allow: the learned gate, the operator-derived store
(mined denies + remembered allows), and the mint-time certificate
(Idea 1) must agree; any disagreement routes the action to the operator,
and the disagreement event itself is ledger-recorded — which source said
allow, which said deny or don't-know, and which was vindicated by the
operator's verdict. Three properties make it research rather than
engineering. (a) The disagreement stream is an ACTIVE-LEARNING query set
on the real permission surface: operator attention is spent exactly where
the learned governance is uncertain or self-contradictory — the direct
answer to the 93%-rubber-stamp habituation Auto Mode was built to escape,
and the operator-decision distillation surface (show the human only what
the learner cannot resolve). (b) The sources are heterogeneous IN KIND —
a text-model classifier vs counted human keystrokes vs language-level
certificates — so the usual ensemble objection (correlated failure) is
measurable instead of assumed: AmPermBench (arXiv:2604.04978) already
found the structural version of the problem, Tier-2 actions (Edit/Write on
project-local files) bypassing the classifier 100% by construction while a
mined `write:` deny sees them perfectly. (c) The camouflage attack: an
adversary that stays in-distribution for EVERY source simultaneously —
measured attack success as a function of auto-allow volume, the
attention-vs-security frontier that no single-source gate can characterize.

**Why nobody has it — product evidence.** Auto Mode is single-source by
construction: classifier reviews Tier 3, allowlists skip it, scores are
not logged or exposed, denial reasons return to the agent with a retry
budget — no cross-check against the operator's own accumulated history.
The "LLM jury, disagree → escalate to human" pattern exists as vendor
engineering practice (orq.ai's weak-judge panels for CONTENT moderation);
OpenCode has a feature request (not an implementation) for a command-
approval classifier. AgentGuardian enforces one learned policy. Progent's
approver routing is per-rule static configuration. No permission harness
cross-examines a learned gate against operator-mined history or surfaces
the disagreement as a governed, auditable stream.

**Why nobody has it — paper evidence.** Ensemble Monitoring for AI
Control (arXiv:2605.15377) ensembles diverse MONITORS to catch
misalignment — output-watching, not privilege adjudication, and no
operator-history source. Conformal Social Choice (arXiv:2604.07667) gives
ensemble classification coverage guarantees for deliberation, not
permissions. Team of Rivals (arXiv:2601.14351) escalates unresolvable
contradictions to humans — a task-architecture pattern, not a governance
surface. AmPermBench is evaluation-only and explicitly non-adversarial
("this is not adversarial exploitation"), measures no calibration, no
audit, proposes no mechanism — its Tier-2 finding is this idea's
motivating measurement, unexploited by its own authors. The
learning-to-defer line (Mozannar & Sontag lineage) defers to a fixed
human on a fixed distribution with no adversarial proposal channel and no
permission semantics; active learning is classic but assumes the learner
controls the query distribution rather than an adversary laundering
malicious actions into the agreeable region. The specific claim —
cross-examining a learned permission gate against operator-derived
policy, with the disagreement stream as both audit artifact and training
signal, under a camouflage adversary — is unoccupied.

**First experiment on the codewhip apparatus.** Add an Auto-Mode-class
gate arm to the bench (a second small model as the Tier-3 gate — the
runner already takes arbitrary ports; the scripted operator already
models the human). Arms: gate-only / store-only / concurrence-required
(disagreement routes to the scripted operator) / concurrence + certificate.
Cells: (1) the frontier — attack success (RQ3 held-out variants + seed
attack suite) vs operator ask-volume per arm, the paper's headline curve;
(2) the Tier-2 replication — the `policy-tamper` task class crossed with a
gate that does not see write subjects: does concurrence close the
classifier-blind gap (AmPermBench's finding, tested causally); (3) the
camouflage cell — the adaptive attacker restricted to actions in-
distribution for both sources, scored on escape rate; (4) the habituation
cell — disagreement volume per run over the persistence window: does the
surface decay into a new rubber stamp (echoing TOPS item 8's
mechanism-designs-the-population question with a governance source
instead of a consent screen). Boundary note: `negotiation-lens.md` Idea 1
(precedent ladder) adjudicates an ask AFTER it is shown with citations;
this idea selects WHICH asks are shown — the two compose (precedent
citations rendered on disagreement events) and neither subsumes the
other. All metrics are decision-log native; the gate and filter are
bench-layer, no frozen-schema edit.

**Strongest reviewer objection.** "Agreement-gating is the LLM-jury
pattern from vendor blogs with permission vocabulary, and your sources
share a provider so correlated failure is exactly what you'll measure."
Answer: vendor juries vote on content with same-family judges and never
gate privilege; here the sources differ in KIND (learned text classifier
vs human-keystroke counts vs language semantics), which is precisely why
the Tier-2 blind spot exists — one source is structurally incapable of
seeing what another sees, a correlation structure no same-family jury
has. And the correlated-failure question is answered empirically by the
camouflage cell: if concurrence fails, the measured residual escape rate
is the paper's soundness limit for ensemble governance — the same move
that makes systems-lens Idea 3's corpus limit publishable, applied to the
source side instead of the probe side.

---

## Killed ideas (with the evidence that killed them)

1. **Counterfactual policy simulation / backtest-validity as a standalone
   headline — KILLED (double-taken).** Flip-set backtesting of policy
   mutations over adjudicated history is already claimed by OUR OWN
   `systems-lens.md` Idea 1(b) — re-proposing it here would salami-cut a
   sibling. The wider OPE/shadow-mode frame for agents is occupied in
   2025–26 papers: the Trustworthy Agentic AI survey (arXiv:2605.23989)
   formalizes the shadow→canary→promotion ladder; Safe Upgrade
   (arXiv:2604.08059) already asserts offline estimates don't transfer to
   live deployment; Agent libOS (arXiv:2606.03895) records counterfactual
   outcomes in shadow mode; OPE for multi-turn LLM agents exists
   (arXiv:2510.17173); "Benchmarks Are Not Validation" (arXiv:2607.28840)
   owns the backtest-insufficiency argument. The one live fragment —
   measuring flip-set VALIDITY when proposals are not policy-invariant
   (adaptive agents change what they propose under a candidate policy) —
   is folded into Idea 1's first experiment as the backtest-preview
   validation cell; standalone it is a validation appendix, not a paper.

2. **Self-verifying policies (held-out attack corpus before minting) —
   KILLED (sibling-taken).** `systems-lens.md` Idea 3 (quarantine mining)
   IS the probe-corpus promotion gate: shadow evaluation against held-out
   variants plus benign near-misses with a precision floor, adversarial
   probe selection included. Restating it as "self-verifying" is the same
   mechanism in different vocabulary. The semantic complement survives
   inside Idea 1 (certificates state what probes cannot: exact language
   membership and reachability), which is why Idea 1 is careful to
   position the structural tier as probe-independent rather than
   competing with the quarantine.

3. **Sequence-level anomaly detection of agent pathologies as such —
   KILLED (lane closed).** The within-run trajectory-anomaly lane is
   fully occupied: AgentSentry (arXiv:2602.22724 — injection as temporal
   causal takeover, localized by counterfactual re-execution), TrajAD
   (arXiv:2602.06443), Trajectory Guard (arXiv:2601.00516), SentinelAgent
   (arXiv:2505.24201), TRACE (arXiv:2606.07054 — hidden objectives across
   individually benign actions), plus product Agent Behavior Analytics
   (Exabeam) and cross-baseline agent UEBA (Cloudanix). A fifth
   trajectory detector with agent-specific feature engineering would be
   "just ML on logs" with better features. Only the mining-feed variant
   survives, as Idea 2, because its protected asset (the learner's
   training set), its detection unit (the proposal×decision sequence),
   and its action (promotion gating) are unoccupied by every paper and
   product above.

4. **Risk-scored ask routing / audited risk scores as the headline —
   KILLED (taken at product speed).** the incumbent's Auto Mode made a
   classifier the default approver (2026-08-14), with tiering
   (allowlist skips, classifier reviews Tier 3) that IS risk routing;
   AmPermBench (arXiv:2604.04978) already stress-tested it; AgentGuardian
   (arXiv:2601.10440) already learns ABAC access control from traces.
   The auditable-score fragment — per-decision score on the hash-chained
   ledger, calibration recomputed from operator overrides, denial-reason
   leakage (the retry budget hands the agent a policy-boundary oracle)
   — survives as components of Idea 3's disagreement ledger; the routing
   mechanism itself has no standalone delta left for us to claim.

## Cross-idea note: one learner, three guardians

The three survivors guard the SAME learned asset — the interaction-derived
policy — at its three trust points: Idea 1 certifies what was minted
(soundness), Idea 2 watches what fed the mint (integrity), Idea 3
adjudicates between learned sources (agreement). They share two artifacts:
the decision ledger (Idea 2's feature source, Idea 3's disagreement
record, Idea 1's statistical calibration set) and the certificate format
(Idea 1 defines it; Idea 2's alarm calibration and Idea 3's concurrence
verdicts are expressible as certificates over streams and sources). New
bench profiles added across the ideas are disjoint from every sibling
lens: the groomer (Idea 2), the camouflage attacker (Idea 3), the
certified-rule attacker (Idea 1) — none shared with economics-lens's
budgeted escalator and history-shaper, systems-lens's corpus-aware
poisoner and quiet-editor, negotiation-lens's incremental widener.
Governance discipline per `AGENTS.md`: certificates and alarm records are
sidecars keyed by existing hashes/(tool, shape, policyVersion), the
outcomes and audit schemas stay frozen; three product changes need
recorded rulings before implementation — the mint-time certificate gate
(Idea 1), the promotion-pipeline alarm hook (Idea 2), and any real
deployment of concurrence gating outside the bench (Idea 3). Timing note:
Auto Mode's default-on date (2026-08-14) and AmPermBench's April-2026
evaluation make Idea 3's motivating measurements current as of
submission; the classifier may have changed — the bench arm is defined
against the PATTERN (single learned gate), not the product.
