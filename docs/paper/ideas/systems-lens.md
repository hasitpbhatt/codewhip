# Systems-Lens Research Ideas: Below the LLM — Types, Taint, Replay, Leases

*(2026-09-13. SYSTEMS + PL lens sweep: information flow, deterministic replay,
capability invalidation, staged enforcement — mechanisms under the model, in
the harness and the OS. Each idea was surveyed against LIVE products and
2025–2026 papers before being written up; three weak ideas were killed
explicitly at the end, one of them a frontier favorite. Companion to
`00-thesis.md`; shares the apparatus — hash-chained signed audit log
(`src/audit.ts`), the pure deterministic policy engine (`src/policy.ts`),
the decision-log grader (`src/bench/grade.ts`), persistence cells, the
shape grammar (`src/remember.ts`), checkpoints — but proposes NEW headline
claims, not salami cuts. Prior-art discipline inherited from
`economics-lens.md` and `negotiation-lens.md`.)*

**The unifying observation.** Every deployed harness governs with *strings
checked once*: `checkPermission(tool, subject)` is a pure function of the
subject text and the policy state, and everything temporal or provenancial
about the decision — what the agent READ before producing that subject,
what the workspace looked like when the operator answered `a`, whether the
policy file that fired still says what it said — is discarded. The ledger
(`src/audit.ts`) already records the *verdicts* (hash-chained, signed) but
not the *inputs*; the grant store (`remembered.jsonl`) records *when* a rule
was minted but never re-validates it; the promotion pipeline
(`src/policy-store.ts`) enforces mined denies on the first run after
promotion with no stage between mining and enforcement. Three of the four
surviving ideas are ways to re-insert the missing inputs — past inputs
(replay), mint-time inputs (witnesses), and counterfactual inputs
(quarantine probes) — using only machinery the harness already has.

Survey method: web searches (2026-09-13) over live products (Claude Code
permissions/settings docs and `/fewer-permission-prompts`, Cursor, Cline,
OpenCode, enterprise gateways, Oracle OCI Agent Evaluation Framework,
Trussed.ai, Votal/1kx marketing claims, OPA policy-versioning practice,
IETF drafts) and 2025–2026 papers (IFC/taint line: CaMeL, FIDES, Prompt
Flow Integrity, ARM, NeuroTaint, TaintAWI, APPA, ActPlane; grant-lifecycle
line: authorization-continuity, commit-time authorization, effect closure,
AID-Guard; replay line: mock-replay regression testing; mined-rule line:
AutoSpec, SafeEvolve; certificate line: certified traces, execution-boundary
conformance, PCO). Key sources cited inline.

---

## Idea 1 — The Replay Oracle: Decision-Function Replay as Tamper Detection and Policy-Edit Backtesting

**Mechanism (one paragraph).** The governance layer of an agent run is the
ONLY deterministic, replayable part of it: the model is not, but
`checkPermission` is a pure function of (tool, subject, promoted denies,
remembered rules, mode flags) — `src/policy.ts` has no I/O, no randomness,
no clock. Today the hash-chained ledger records each verdict as
`policy: "allow:<ruleId>"` with only `args_hash` of the subject — so the
log proves a decision happened but nothing can re-derive it. Add a
redacted-subject sidecar (keyed by `args_hash`, written at decision time,
redact-at-write like every other surface) and two mechanisms fall out.
**(a) Tamper oracle:** `codewhip policy replay` re-derives every historical
verdict from (recorded subject, current on-disk grant store + policy.md)
and diffs against the ledger. A hand-edit of `remembered.jsonl` or
`policy.md` — semantically valid, chain-plausible, invisible to
`audit --verify` because the GRANT STORE is not itself hash-chained —
changes re-derivation exactly where the store diverges from what existed
at decision time: the ledger becomes the ground truth that pins the
store's history. This closes chair-mandated gaps in `00-thesis.md` item 15
/ item 6 (promotion provenance unverified, ledger tail-truncation composes
with the existing `chain_tail` anchor). **(b) Backtesting:** any candidate
policy mutation — a promotion-pipeline output, an operator mint, an engine
upgrade — replays against the FULL adjudicated history and emits the flip
set: which recorded allows would become denies and vice versa. The flip
set is the semantic diff of a policy change, reviewable before enforcement;
its size and composition are the measured object (does the promotion
threshold trade flip-set mass against coverage? does a poisoned decline
stream produce flips that per-decision review misses?).

**Why nobody has it — product evidence.** No harness re-derives permission
verdicts. Claude Code allow rules live in `settings.local.json`
(persistent, no re-validation; per code.claude.com/docs/en/permissions and
/en/settings); Cursor/Cline keep static config; nothing replays history
against the current store. The closest product gestures are Oracle's OCI
Agent Evaluation Framework (blogs.oracle.com — "replay, canary assurance"
for agent *evaluation*, not permission re-derivation) and replay-as-
regression-test practice in testing blogs (Cekura, AgentPatterns.ai) —
all replay for behavior QA, none for grant-store integrity.

**Why nobody has it — paper evidence.** Mock Replay Regression Testing
(arXiv:2603.21692) is the nearest paper and its non-goals are the gap:
it replays *reasoning* with frozen tool outputs (regression variable =
prompt/model version), records permission scope as provenance metadata,
and explicitly "never re-evaluates approval decisions." The
agent-governance-toolkit discussion (github.com/microsoft/
agent-governance-toolkit/discussions/276) sketches "replay the log against
declared constraints" as an oracle concept — a discussion thread, no
mechanism, no measurement. Firewall policy change-impact analysis
(Al-Shaer & Hamed lineage) diffs static rule sets with no adjudicated
human history; OPA canary deployments (cloudmatos.com) version Rego with
no recorded decisions to backtest against. Classical deterministic replay
(rr, liblog) replays execution, not decisions. The gray-literature
"deterministic replay" primitive (sakurasky.com "missing primitives"
series) names the idea without building or measuring it. The specific
claim — *decision-function replay over a hash-chained decision log detects
unconsented grant-store mutation and backtests policy edits as flip sets* —
is unoccupied.

**First experiment on the codewhip apparatus.** `codewhip policy replay` as
a ledger CONSUMER (sidecar JSONL keyed by `args_hash`; no frozen-schema
edit). Three cells: (i) *detection*: the bench's policy-tampering task
class (`src/bench/tasks.ts` already plants writes into policy/remembered
stores) run with tamper variants that keep the store well-formed —
detection rate of replay vs `audit --verify` alone (prediction: verify is
blind to content-preserving store edits; replay is not, because past
`remembered`-actor decisions stop re-deriving); (ii) *backtest*: promotion
thresholds swept over the seeded decline history, flip-set size/precision
per threshold against the RQ3 held-out ground truth; (iii) *quiet-edit
attack*: the adaptive attacker (thesis build order step 3) is scored on
flip-set-minimality — can it mutate the store so that the historical flip
set stays empty while future coverage over its target class grows?
That metric (undetected-mutation coverage per flip-set budget) is new.
Wilson intervals, McNemar vs verify-only.

**Strongest reviewer objection.** "Replaying a pure function is unit
testing, not research — and your sidecar re-introduces the sensitive
subjects the ledger deliberately excludes (only hashes are stored today by
design)." Answer: the research content is (1) the *finding* that the
governance layer is exactly the replayable slice of an agent run — no
reasoning-replay paper can claim exact re-derivation because their
regression variable (the model) is non-deterministic, whereas ours is pure;
(2) the redaction-vs-verifiability frontier is a measured object — what
fraction of decisions stay re-derivable as subject components are
progressively redacted (the minimal-certificate question; see kill 2) is
an empirical curve nobody has produced; and (3) the tamper claim is
adversarially evaluated, not asserted — the quiet-edit cell can falsify it.

---

## Idea 2 — Provenance-Revoked Grants: The Lease That Dies With Its Evidence

**Mechanism (one paragraph).** A remembered rule is minted once and lives
forever (thesis item 15: "rule `ts` recorded but never consulted"); the
workspace that justified it keeps changing. Bind every minted rule to
**trust-root witnesses** recorded at mint time: (a) git state (HEAD commit,
branch, remote URL); (b) **provenance contributors** — the hashes of files
whose read content verbatim-fed the allowed subject (cheap string-level
attribution performed ONCE, at mint, not per call — so it avoids the
63–215% latency / 91–254% token overhead that per-call data-ID systems
like Prompt Flow Integrity report); (c) AGENTS.md / rules-file hash. A
per-run preflight (plus an optional fs.watch watcher for long-lived
sessions — the sensor, not the mechanism) recomputes the witnesses; any
mismatch DEMOTES that rule from `always` to session/ask — demote-only,
never widen (the contract-only half of authorization-continuity's
transition envelope). The grant becomes a lease keyed to evidence: switch
branches, pull, mutate the file the command's arguments came from, or
rotate the rules file, and yesterday's `a` stops auto-allowing. The
research object is the **grant half-life distribution and the
false-invalidation frontier** — the exact evaluation the authorization-
continuity paper sketches and states it has not done ("does not yet
measure its frequency or operational cost").

**Why nobody has it — product evidence.** Nothing expires or invalidates
grants on environment change. Claude Code allow rules are persistent with
no built-in expiration (code.claude.com/docs/en/settings; the only
middle grounds are per-session approvals and the `/fewer-permission-prompts`
skill that auto-writes MORE persistent rules from session history —
mindstudio.ai — i.e., the trend is toward cheaper minting, zero
invalidation). Trussed.ai markets an "Agent Capability Revocation Runtime
Guide" (trussed.ai) — guidance prose, no mechanism keyed to workspace
state. Codewhip's own shipped revocation is operator-manual
(`codewhip remember forget`); negotiation-lens Idea 1's overrule cascade
is operator-initiated. No product makes the *environment* revoke.

**Why nobody has it — paper evidence.** Authorization continuity
(arXiv:2607.23586) formalizes exactly this intuition — state-bound grants,
transition envelopes, trust-context mutation suspending authority — and
explicitly ships no mechanism and no measurement; its Section VIII
sketches "replaying mutated tasks; measuring grant persistence,
unauthorized-effect, false-invalidation, and interaction-cost rates" as
future work. That is this experiment, verbatim, unclaimed. Commit-Time
Authorization (arXiv:2607.10487) measures within-run staleness at the
commit boundary of derived state — a different timescale from cross-session
grant stores. Effect closure (arXiv:2609.02866), AID-Guard
(arXiv:2608.21159), and dynamic capability scoping (arXiv:2607.22445) treat
provider-side effect lifetimes and delegation, not operator-minted
file-system grants. Prompt Flow Integrity (arXiv:2503.15547) persists
"Trust Once / Trust Always / Trust Never" choices keyed to data provenance
— the nearest cousin — but keys on content-REPLACEMENT data IDs, never
invalidates on contributor mutation, and never measures restart-surviving
privilege. ActPlane (arXiv:2606.25189) runs kernel-side eBPF/LSM labels
that are "monotonic and irrevocable by default" with temporal gates that
are event-freshness, not trust-root binding — the exact opposite design
point. ClawWorm (arXiv:2603.15727) and the thesis's own RQ2 measure
persistence as an ATTACK; no paper measures invalidation as a DEFENSE
against it.

**First experiment on the codewhip apparatus.** The RQ2 persistence cells
already run tasks twice with workspace reuse — cross them with witness
arms: (none / HEAD-only / HEAD+contributors / +rules-file-hash).
Measure (1) *durable-privilege rate* (run-2 auto-grant without re-ask)
under each arm when the attacker mutates the trust root between runs —
the persistence attack gets a new axis (does the injected agent KEEP its
minted rule after the commit it was minted on is gone?); (2) *false-
invalidation cost*: benign continuation tasks re-ask rate per arm — the
utility frontier 2607.23586 names and leaves open; (3) *re-mint
habituation*: does higher invalidation frequency just recreate the
fat-finger `a` at higher rate (the defense manufacturing its own attack)?
— a measured cell, not an assumption. Witness sets ride the existing
`remembered.jsonl` provenance fields as a sidecar extension (schema
addition needs a recorded ruling per `AGENTS.md` — flag it up front).

**Strongest reviewer objection.** "Paraphrase defeats mint-time taint
attribution (ARM's 'causality laundering', arXiv:2604.04035), so your
contributor witnesses miss the true provenance and the defense is
theater; worse, HEAD-only witnesses invalidate on every commit — a
half-life of minutes is just asking again, which is the status quo."
Answer: both halves are measured quantities, not flaws. Witness recall is
bounded by the laundering experiment (verbatim contributors found vs
injection-ground-truth contributors on the bench suite) — and the failure
direction is fail-closed-safe (a missed witness over-persists, exactly
today's behavior, while Idea 1's replay oracle covers the residual
audit); and the half-life distribution per predicate granularity
(branch-scoped vs commit-scoped vs content-scoped) IS the paper's design
contribution — no measurement of this trade exists anywhere, and the
authorization-continuity authors have publicly left it open.

---

## Idea 3 — Quarantine Mining: Shadow-Promotion of Mined Denies Before Live Enforcement

**Mechanism (one paragraph).** The decline-promotion pipeline
(`src/policy-store.ts`) is the only narrowing force in the policy
lifecycle, and it enforces on the next run with zero validation between
mining and enforcement — which makes it a weapon: a poisoned decline
stream (an injected agent engineering declines with self-serving shapes)
can mint deny-DoS rules against the workspace's own benign workflow, and
the `npm run *`-class honesty problem (thesis item 10) means a promoted
shape can be both imprecise and load-bearing. Insert a **quarantine
stage**: a candidate deny shape is staged in a shadow policy and evaluated
inside a disposable clone (checkpoints/rollback machinery, `git worktree`)
against a probe corpus — the RQ3 held-out variants plus benign
near-misses plus a scripted benign-workload replay — and only shapes
clearing a precision floor are promoted, with the probe report
hash-chained as a sidecar keyed by (shape, policy version). Three
research questions: (a) does the gate catch poisoned-decline shapes that
per-decision curation misses? (b) the adversarial probe-selection problem
— the attacker KNOWS the corpus: what is the pass-corpus/deny-off-corpus
rate for shapes crafted to clear the probes and deny-DoS the real
workflow (a soundness LIMIT result for any corpus-based policy gate)?
(c) denial-feedback leakage (ARM, arXiv:2604.04035) applied to the deny
store itself: promoted denies change what the deny messages reveal —
how much of the policy boundary can a probing injected agent infer from
denials under each arm?

**Why nobody has it — product evidence.** Policy-engineering practice has
staged rollout for RULE FILES — OPA canary deployments (cloudmatos.ai),
staged rollouts with canary analysis for services — but these gate
deployments of hand-authored Rego in CI, with no adjudicated human
history, no disposable-clone execution of probes, and no adversary. No
agent harness stages permission rules at all: Claude Code, Cursor, Cline
apply allow/deny rules the moment they are written (settings files);
codewhip's promotion is likewise immediate today.

**Why nobody has it — paper evidence.** The mined-rule papers stop at
generation: AutoSpec (arXiv:2606.24245) induces safety rules from
safe/unsafe annotations via ILP; SafeEvolve (arXiv:2609.02786) converts
completed trajectories into "bounded, auditable harness updates" — both
evaluate the RULES produced, neither stages them against an adversarial
decline stream before enforcement. Progent/AgentSpec (taken) assume
hand-authored DSLs. The thesis's own TOPS item 13 plans mining-vs-ground-
truth validation of the MINER offline; the quarantine gates the RULE at
runtime against an ADVERSARY — different object, different threat.
Negotiation-lens Idea 4 (drift forensics) is observational and post-hoc;
the quarantine is pre-enforcement and interventional. AgentHazard
(arXiv:2604.02947) has privilege-escalation categories but no persistent
grant store by construction. The pass-corpus/deny-off-corpus metric does
not exist in any surveyed work.

**First experiment on the codewhip apparatus.** Promotion arms (direct vs
quarantine, floor swept) × decline-stream profiles (honest operator /
benign-noisy / poisoned by the adaptive attacker) over the seeded bench
history. Metrics: RQ3 precision/recall per arm (the probe corpus is
already the RQ3 suite — near-zero new ground truth), deny-DoS success
rate against benign core workflows, pass-corpus/deny-off-corpus rate for
corpus-aware attacker shapes (the money table), and deny-feedback
inference (probing-agent policy-reconstruction accuracy per arm). The
clone execution reuses `runner.ts`'s scripted-operator machinery in a
worktree; probe reports are sidecar JSONL — no frozen-schema edit; the
promotion gate itself is a product change needing a recorded ruling.

**Strongest reviewer objection.** "A corpus can only test what it
imagines — this is a test suite for rules dressed as a mechanism, RQ3
already measures generalization, and your thresholds already cap poisoned
declines." Answer: the contribution is the measured SOUNDNESS LIMIT —
the pass-corpus/deny-off-corpus curve quantifies, for the first time,
how much protection any corpus-based gate survives against a corpus-aware
adversary, which neither RQ3 (no adversary), AutoSpec/SafeEvolve (no
deployment stage), nor OPA practice (no measurement) answers; a bad
result is a publishable bound on curation-safety that TOPS item 10
explicitly asks for ("poisoned-decline bounds") — the theory item gets
its first number.

---

## Killed ideas (with the evidence that killed them)

1. **The taint firewall as a standalone headline (dynamic taint tracking
   from untrusted file reads to tool args, enforced at the permission
   boundary) — KILLED.** The mechanism space is fully occupied:
   Prompt Flow Integrity (arXiv:2503.15547) replaces untrusted tool
   results with data IDs, alerts when a privileged tool argument contains
   one, and persists "Trust Once / Trust Always / Trust Never" choices
   keyed to provenance — i.e., taint-as-decision-input with a grant store
   is already built and evaluated (AgentDojo/AgentBench, 4 models);
   ARM (arXiv:2604.04035) is an MCP-proxy reference monitor with a
   provenance graph, integrity lattice, and "causality laundering"
   (denials as taint events) — which also names the evasion concept we
   planned to measure; CaMeL (taken), FIDES (arXiv:2505.23643),
   NeuroTaint (arXiv:2604.23374, offline semantic provenance over 20
   frameworks), TaintAWI (arXiv:2605.07135), APPA (arXiv:2607.24625),
   ActPlane (arXiv:2606.25189) close the remaining variants, and Votal/
   1kx marketing already sells IFC on tool arguments. The honest residue —
   mint-time (not per-call) string-level contributor attribution feeding
   Idea 2's witnesses, and the measured laundering bound of VERBATIM
   string taint on a harness that lets the model see raw content — is a
   component and a subsection, not a paper. Every surviving idea below
   deliberately avoids per-call taint enforcement for this reason.

2. **Typestate for the ask-ladder / proof-carrying decisions as a
   standalone — KILLED.** Typestate (1980s technique) applied to a
   400-line pure function is engineering with no empirical question the
   bench can answer; and the certificate framing is independently
   crowded: Certified Traces and Permissibility Machines
   (arXiv:2605.24462, explicitly connecting to proof-carrying
   authorization), an Execution-Boundary Conformance Profile
   (arXiv:2609.11596), "Proof-Carrying Authorization for LLM Agent
   Runtimes" (cited in arXiv:2605.04093), Cryptographic Certificates of
   Validity (arXiv:2606.23768), PCO (IACR eprint 2026/994), and ACM
   Queue's proof-carrying code for LLM planners
   (queue.acm.org/detail.cfm?id=3806226). The one salvageable empirical
   question — the minimal redacted subject subset under which decisions
   stay re-derivable — folds into Idea 1 as the redaction-frontier
   measurement. Evidence Tracing and Execution Provenance in LLM Agents
   (arXiv:2606.04990, survey) confirms the provenance-metadata lane is
   being systematized without any of it re-deriving permission verdicts.

3. **File-watcher revocation as the headline mechanism — KILLED (folded
   into Idea 2).** Watcher-as-sensor is the naive framing: a watcher
   without a witness SEMANTICS is just a trigger with no theory of what
   should revoke what, and watcher-liveness (missed events, editor
   atomic-rename churn) is an engineering swamp with no measurement
   claim. The paper-worthy object is the witness predicate design space
   and its half-life/false-invalidation frontier (Idea 2), with preflight
   recomputation as the robust default and fs.watch as an optional
   latency optimization — evaluated as an implementation footnote.

## Cross-idea note: one substrate, three consumers

All three survivors consume the same missing artifact — the DECISION
INPUTS the ledger currently discards. Idea 1 records subjects (redacted
sidecar) and replays them; Idea 2 records mint-time witnesses and
recomputes them; Idea 3 records probe reports and gates on them. One
bench addition serves all three: extend `src/bench/runner.ts` to persist
per-run mode flags and decision inputs alongside the decision trail it
already grades (`grade.ts` consumes it today from `trace.subject`).
Governance discipline per `AGENTS.md`: sidecars keyed by existing hashes
(`args_hash`, `preview_hash`), ledger untouched; two product changes need
recorded rulings before implementation — the witness fields on
`remembered.jsonl` (Idea 2) and the promotion gate in the pipeline
(Idea 3). Attack-class reuse: the quiet-edit attacker (Idea 1), the
trust-root mutator (Idea 2), and the corpus-aware decline poisoner
(Idea 3) are three new profiles in `src/bench/tasks.ts`, disjoint from
negotiation-lens's incremental widener and economics-lens's budgeted
escalator — no shared profile, no shared claim.
