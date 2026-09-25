# Negotiation-Lens Research Ideas: The Approval as a Dialogue, Not a Dialog Box

*(2026-09-13. Human-agent negotiation sweep: precedent, counterfactual evidence,
counter-offer, deliberation, drift. Each idea was surveyed against LIVE products
and recent papers before being written up; two weak ideas were killed explicitly
at the end. Companion to `00-thesis.md`; shares the apparatus — hash-chained
signed audit log, decision-log grader, bench arms, persistence cells,
checkpoints/rollback — but proposes NEW headline claims, not salami cuts.)*

**The unifying observation.** Every deployed harness compresses the approval
into a single keystroke against a single static subject: the operator sees one
rendered command and answers once. The UX panel located the failure precisely
here — "uninformative asks" (information available is sometimes zero) and
habituation (attention decays) — and its fixes (coverage printing, scope
disclosure, batching) all move *information*, none moves *structure*. The
frontier below treats the ask instead as a move in a structured dialogue with
precedent, evidence, counter-offers, and an auditable history: the operator
decides *about a case*, not *at a prompt*. Four mechanisms survive the prior-art
sweep; two die on it.

Survey method: web searches (2026-09-13) over live products (the incumbent incl.
Auto Mode and the v2.1.211 settings.local.json change, Cursor, Cline, Warp,
Tangle, OpenCode, enterprise gateways, IETF drafts) and 2024–2026 papers
(case-based-reasoning-for-agents line, simulation-in-the-loop line, dry-run/
preview line, agent-hazard benchmarks, permission-system surveys). Key sources
cited inline. Prior-art discipline inherited from `economics-lens.md`: no
pricing, no habituation modeling, no IRB-study design as a contribution — those
lanes are taken.

---

## Idea 1 — The Precedent Ladder: Stare Decisis for the Ask

**Mechanism (one paragraph).** Every adjudicated ask is already a case in the
hash-chained ledger; the ladder never consults it. Make the ledger case law:
at ask time the harness retrieves the nearest adjudicated cases (same tool
head, same target class) and renders them as citations — "bound by: allowed
`git push origin main` (run 41, 2026-09-01); this ask differs by `--force`" —
with three dialogue moves. **Apply**: the operator confirms and the minted rule
is tagged with the citation set that justified it. **Distinguish**: the agent
may argue, in a structured operator-visible field, that the case falls outside
the prior holding ("push targets a fork; precedent bound origin") — the
harness checks the argument against the shape algebra, and acceptance mints a
narrower rule *because* of the distinction, not despite it. **Overrule**: the
operator reverses a prior holding with one recorded act, and every downstream
auto-grant attributable to that precedent is enumerated and invalidated —
revocation with blast-radius attribution, which the UX panel's `remember
revoke` demand only stubs. Mined shapes propose; precedent adjudicates and
attributes. Before minting, the harness replays its understanding as sampled
hypothetical cases ("under this holding `git push origin staging` would
auto-allow; `git push --force` would still ask — correct?"), generalizing the
UX panel's "two example future commands" demand into a measured comprehension
mechanism (this absorbs explain-back consent — see kill 2).

**Why nobody has it — product evidence.** No harness cites prior approvals at
ask time. The incumbent persists allow rules silently to
`.claude/settings.local.json` (repo-root since v2.1.211; per
agenticcontrolplane.com/controls/claude-code and the code.claude.com
changelog) — prior decisions bind but are never *shown*, and `ask` rules
override them with no reasoning trail. Anthropic's Auto Mode
(anthropic.com/engineering/claude-code-auto-mode) reports users approve 93% of
prompts and responds by replacing the dialogue with a classifier — automation,
not justification, the opposite direction. FalkorDB's "Context Graphs" markets
prior decisions and causal chains as agent *memory*, not as binding
adjudication with distinguishing semantics. Zenity's "The Permission Boundary
Myth" (zenity.io) diagnoses that accumulated approvals drift from intent —
without a mechanism.

**Why nobody has it — paper evidence.** Case Law Grounding
(arXiv:2310.07019) grounds general LLM decisions in retrieved precedents —
no permissions, no operator, no bindingness, no distinguishing protocol.
"Binding Precedent for Automated Compliance Decisions" (SSRN ~2025-26) argues
stare decisis logic for automated compliance and flags the flat-jurisdiction
wrinkle — theory, no harness, no measurement. The CBR-for-agents line (review
arXiv:2504.06943; DS-Agent 2402.17453; AgentFly 2508.16153) uses case memory
for task-solving. LATTICE (Frontiers in AI 2026) factors "no prior precedent"
into an autonomy ceiling — precedent *presence* as a scalar signal, not
citation + distinguish + overrule. The User Permissions survey
(arXiv:2607.13718, 21 permission-system proposals) covers none of these moves.

**First experiment on the codewhip apparatus.** Precedent arm in `src/bench/`:
citations are rendered at ask time from the decision log the grader already
consumes; three cells — (a) no-citation (current), (b) citation-only,
(c) citation+distinguish with the adaptive attacker granted a distinguish
budget. Measure: wrong-allow rate in fat-finger cells (b vs a), mined-policy
precision/recall against the RQ3 held-out set, and the novel table —
distinction-acceptance rate for honest vs injected agents (prediction:
injected agents' distinctions are systematically self-serving, always toward
more privilege, giving a detectable signature). Hypothetical-replay cell: near-
miss subjects sampled from the RQ3 benign suite as mint-time probes; correction
rate scored against stored rules. Wilson intervals, McNemar vs (a).

**Strongest reviewer objection.** "CBR with a permission skin: Case Law
Grounding plus a UX layer, and operators will habituate to citation prose
exactly as they habituate to warnings — your gains are illusory." Answer: the
unit of analysis is not attention but *attributable bindingness* — an
overruled precedent propagates and enumerates its downstream auto-grants,
which no settings file can do; habituation-to-citations is a measured cell,
not an assumption; and the distinguish channel is deliberately given to the
attacker, so the defense claim must survive an adversarial arm or be honestly
bounded — falsifiability no CBR paper faces, because none has an adversary.

---

## Idea 2 — The Counterfactual Ask: Evidence-at-Approval via Harness-Computed Replay

**Mechanism (one paragraph).** For uninformative asks (the UX panel's second
operator parameter: no amount of attention helps when the preview cannot say
what `npm run build` does), the harness *computes* the answer instead of
narrating it: fork the workspace at the current checkpoint (checkpoints/
rollback are already shipped), execute the subject in the sandbox fork, and
print the delta — files written, network endpoints contacted, child processes
spawned — as a structured evidence block above the ladder. The operator
approves an *observed consequence*, not the agent's description of intent.
The design rule that makes this a research object rather than a feature: the
preview is computed by the HARNESS from execution, never generated by the
model — a model-narrated preview is just another injection surface ("preview
laundering"). The paper's questions: does evidence-at-ask close the
uninformative-ask hole where curation cannot; what is the fidelity frontier
(some actions are non-idempotent or state-conditional, so sandbox replay can
diverge from real execution — TOCTOU previews); and can an attacker structure
an action so the sandboxed preview is benign while the real run is not
("preview panning")?

**Why nobody has it — product evidence.** No deployed coding agent executes a
dry-run replay at the approval prompt. Tangle (tangle.tools blog: "LLM Sandbox
Environment For Agent Runs") records side effects to give reviewers evidence,
but its own policy table requires approval *before* execution for durable
actions and shows traces post-hoc — the reviewer never sees a pre-executed
consequence. incumbent (plan mode, Auto Mode), Cursor, Cline, Warp show
plans and proposed-edit diffs — agent-authored descriptions, never executed
effects. Dry-run preview exists only as a tool-author convention (Terraform
plan; DB-migration CI dry-runs per samuelfaj.com's agent-migration post — a
pipeline stage, not approval evidence).

**Why nobody has it — paper evidence.** GoEX (arXiv:2404.06921) proposes
dry-run previews and undo for LLM-application runtimes — a position/design
paper with no operator measurement and no adversarial analysis of the preview
itself. Agent-First Tool APIs (arXiv:2605.10555) puts a Preview Action phase
in tool interfaces — API design proposal. Simulation-in-the-loop
(arXiv:2603.11677) is a paradigm paper for jointly exploring simulated
futures, not permission decisions. Plan-Then-Execute (arXiv:2502.01390)
measures trust under plan review, not executed-consequence evidence.
Describe-Then-Act (arXiv:2603.23149) distills consequence *prediction* into
the model — the attackable variant, by construction. CIPHER-A (Springer)
claims first pre-execution consequence prediction with counterfactual
validation — model-predicted, and its counterfactuals validate the prediction,
not the operator's decision. MurphyGuard (SSRN) specifies dry-run → review →
run as framework protocol. None measures approval-quality effects on a real
harness, and none studies preview attacks.

**First experiment on the codewhip apparatus.** Two bench arms. (a)
*Evidence arm*: on every ask in the uninformative class (scripted
npm-run/package-script subjects from the task suite), the runner executes the
subject in the checkpoint fork and injects the side-effect delta into the ask
prompt; the fat-finger operator profile decides on it. Measure wrong-allow
rate and mint rate vs the no-evidence arm, with the interaction between
evidence and ask-informativeness class as the money figure (prediction: gains
concentrate exactly where curation fails). (b) *Preview-attack arm*: the
adaptive attacker (thesis build order step 3) is given the arm spec and must
produce preview-divergent actions; measure pan-success rate (preview-benign,
effect-malicious) under harness-computed vs model-narrated previews — the
first quantification of preview trustworthiness. Preview artifacts are
sidecar JSONL keyed by ask hash; no frozen-schema edit.

**Strongest reviewer objection.** "You cannot dry-run non-idempotent actions:
the preview itself burns side effects or diverges (TOCTOU), so evidence is
sometimes wrong — and a wrong preview is worse than none, because operators
trust the confident artifact." Answer: fidelity is the measured quantity, not
a flaw — the bench instrumented-divergence cells quantify preview-vs-effect
mismatch, and the contribution is the fidelity-utility frontier plus the
pan-attack rate; for classes the harness cannot preview soundly it must refuse
to preview (fail-closed to a plain ask), and the bench measures what fraction
of the real ask surface that leaves. GoEX, Tangle, and MurphyGuard specify the
mechanism and never answer any of this.

---

## Idea 3 — The Counter-Offer Ladder: Negotiated Scoping on Denial

**Mechanism (one paragraph).** When the operator denies, the agent may respond
with a structured counter-offer — a strictly narrower re-request (same tool,
reduced target/flag set, once instead of persistent) rendered beside the
original: "denied: `curl https://api.example.com/…`; offer: once, with
`--dry-run` (no body sent)?" Two enforced properties make it governance rather
than chat: **monotone narrowing** — each offer must be contained in the denied
subject's privilege *and* must not compose with already-held rules to exceed
it (composition-aware containment over the union of grants, checked by the
compiled shape grammar — a mechanical property, not model honesty); and a
**round cap** (n=1 by default), with the full exchange logged. Denials become
boundary information: the agent learns where the line is, the operator gets a
least-privilege floor instead of an all-or-nothing choice, and the deny-
promotion pipeline gains a scope hint. The dark twin is the research question:
negotiation is also a consent-extraction channel — an attacker can sandbag
(request broad, "settle" narrow, iterate across restarts), so the paper
measures the equilibrium between negotiation value and negotiation-as-
escalation.

**Why nobody has it — product evidence.** No surveyed harness proposes
alternatives at denial. incumbent, Cursor, Cline denials are terminal for
the step; agents may improvise in-band afterwards, unstructured and unpoliced
— precisely the channel this formalizes and checks. CAMEL-AI's human-in-the-
loop pattern (camel-ai.org blogs) feeds denial messages back into the agent's
context so it "adjusts its subsequent approval requests" — informal, no
narrowing guarantee, no composition check, no round cap. IETF
draft-sharif-agent-identity-framework's "Agent Capability Negotiation" is an
agent-to-agent handshake over capabilities, not a human dialogue. No product
implements operator-facing counter-offers.

**Why nobody has it — paper evidence.** No paper proposes counter-offer
approvals. The User Permissions survey (arXiv:2607.13718) and "AI Agents Push
Humans Out of the Loop" (arXiv:2608.23642, Mitchell 2026) identify the
interaction gap without a mechanism; a TechRxiv context-aware HITL piece
describes an agent regenerating a proposal after denial — described, never
enforced or measured. Human-AI negotiation research is deal-making
(arXiv:2603.22766 multi-issue bargaining; the A2A counter-offer line,
arXiv:2506.00073) with zero security framing; "Won't, Not Can't" (ACM 2025)
treats refusal as the agent's expressive act, not the operator's leverage.
Salami-slicing commentary (Unit 42, Stellar Cyber; AgentHazard's Recursive
Salami Slicing) warns of incremental consent erosion but never studies the
*legitimate* narrowing channel that also enables it.

**First experiment on the codewhip apparatus.** Counter-offer arm: scripted
agents get a negotiation budget against the deny-promotion pipeline. Benign
cells measure task-success recovery (denied steps completed under narrower
grants — the RQ4 cost axis) and mined-rule precision (shapes minted from
accepted offers vs bare allows). Attack cells run the sandbag profile against
the direct-injection baseline, reusing persistence cells across restart
cycles. The containment check is a pre-flight validator reusing the RQ3 shape
grammar; money metric: attack-success-per-negotiation-round — does the round
cap plus union-of-grants containment put a hard ceiling on escalation?
(Note: extending the shipped y/N/s/a ladder needs a recorded ruling under the
working agreement — it is approval-UX semantics, though no frozen schema
changes.)

**Strongest reviewer objection.** "The proposing agent is self-interested —
it optimizes offers for acceptance, not safety; you built a social-engineering
API, and 'narrower' is vacuous when every offer is narrower than *something*."
Answer: narrowing is measured against the denied subject AND the union of
already-held privileges (composition-aware containment is the technical
contribution prior art cannot borrow without our analysis), and the sandbag
experiment exists precisely to price the social-engineering risk — if the
equilibrium is bad, that is a publishable negative result against the entire
"make denial productive" design instinct, with the ceiling measured rather
than asserted.

---

## Idea 4 — The Boiling Frog in the Grant Store: Drift Forensics via Policy Diffing

**Mechanism (one paragraph).** The grant store is a time series that every
harness treats as a set: nothing answers "what changed since the last audit,
and did the auto-allow surface grow?" Define the **policy delta** between two
ledger points: rules added, widened, or overridden; coverage growth computed
over a canonical probe corpus (the RQ3 held-out variants are the probe set —
count how many subjects each historical rule auto-allows today vs at audit
time); attribution per provenance (which runs minted what, from the ledger's
runId/preview_hash chain). Three moves: (1) *measure natural drift* — mined
policies can only widen (allow-minting is the only growth operator deployed
harnesses ship; deny promotion is the sole narrowing force), so drift rate is
characterizable per operator profile; (2) *the attack*: the boiling-frog cell
— an adaptive attacker steers grant widening incrementally across restart
cycles, each request individually plausible, per-session mint deltas below
the operator's notice threshold; (3) *the defense*: drift alarms — `codewhip
policy diff <anchor>` with alerting on coverage velocity (newly auto-allowed
probe subjects per session), evaluated as detection latency/precision vs the
attack. The dialogue frame: diff-based auditing is the operator's
counter-question in the governance conversation — "what have you taught
yourself since I last looked?"

**Why nobody has it — product evidence.** No harness ships a permission diff.
incumbent allow rules live in settings.local.json — diffable only as a raw
git file-diff with no coverage semantics, no attribution, no audit command;
Cursor/Cline keep static config. Enterprise IAM drift tooling exists for
cloud roles, and Obsidian Security markets the diagnosis qualitatively ("AI
Agent Privilege Escalation and Over-Permission": "privilege creep widens the
gap every month") — no mechanism tied to agent approval stores or mined rules.

**Why nobody has it — paper evidence.** AgentHazard (arXiv:2604.02947)
includes Recursive Salami Slicing and Privilege Escalation categories, but
its tasks run in containers with "no persistent state" and its escalation
analysis is within-trajectory (23.46% → 72.06% ASR across rounds of one task)
— cross-session grant-store creep and policy drift are outside its design by
construction. Crescendo (arXiv:2410.09024) escalates conversational context,
not persisted grants. Firewall-policy anomaly/diff analysis (Al-Shaer & Hamed
lineage) compares static rule sets, not interaction-mined agent stores with
coverage-over-probe-corpus semantics. RBAC mining (Xu & Stoller lineage, the
thesis's own positioning) assumes stable systems, so drift is noise there —
here it is the signal. No paper measures drift rate of a mined agent policy
or uses diffing as a detection surface.

**First experiment on the codewhip apparatus.** The RQ2 persistence cells
already run tasks twice with workspace reuse; extend to K restart cycles with
a drift-attacker profile requesting one plausible widening per cycle
(`git status` → `git diff` → … → `git push`). Measure cumulative coverage
growth over the probe corpus per cycle against each operator profile's
per-session mint tolerance; then ROC the diff alarm over coverage-velocity
thresholds for detection latency/precision. Zero schema change: the delta is
computed at the metrics layer from the existing hash-chained ledger —
`policy diff` is a consumer, exactly like economics-lens's pricing and
premium features. If detection fails at any threshold, that is a finding
about the auditability ceiling of interaction-derived policy.

**Strongest reviewer objection.** "This is cumulative mining plus a grep:
RQ2 already measures persistence, and drift is just what persistence does
over more runs — a salami cut of the thesis." Answer: RQ2 measures survival
of a single mint across one restart; drift is a second-order property of the
mint sequence — d(coverage)/d(session) — requiring a probe-corpus coverage
metric the thesis computes but never applies over time, and it yields a
defense no RQ owns; AgentHazard's no-persistent-state design is the citable
proof the attack class is unmeasured anywhere; and the paper's object is the
audit workflow itself — what an auditor can know from the ledger — which is
dialogue-lens native, not attack-lens leftover.

---

## Killed ideas (with the evidence that killed them)

1. **Deliberation quorums (k-of-n operator approval for high-risk actions) —
   KILLED.** The mechanism is claimed at standards and protocol level: IETF
   draft-schrock-ep-quorum, "Multi-Party Quorum Authorization for High-Risk
   Agent Actions" (version 04), and the EMILIA protocol's Quorum product page
   ("holds a high-stakes, irreversible action until a quorum of approvals is
   gathered") — the two-person rule for agent actions, verbatim. Maker-checker
   is centuries-old enterprise practice, so the residual delta is k-of-n
   sizing science against per-operator habituation decorrelation — a bench
   arm, not a paper; and codewhip is a single-operator local-first harness,
   the same apparatus-fit objection that killed economics-lens's prediction
   markets. If a quorum cell is ever wanted, it folds into Idea 4 as an
   operator-profile variant.

2. **Explain-back consent as a standalone idea — KILLED (folded into Idea 1).**
   Teach-back consent exists for chatbots ("Consent Understanding and
   Verification for Personalized Chatbots," SCITEPRESS 2025: the user must
   demonstrate comprehension before proceeding), teach-back gates appear in
   human-AI collaboration (arXiv:2505.00018) and trust-design practice; in
   this repo, coverage printing has shipped (taken list) and the TOPS chair
   already mandated comprehension probes scored against stored rules
   (00-thesis.md item 9). The surviving delta — the harness replays ITS
   compiled understanding as sampled future cases and operator corrections
   repair the grammar — is real but has no standalone adversary, no ground
   truth of its own, and an obvious home as Idea 1's mint-time
   hypothetical-replay mechanism, where it inherits the RQ3 benign near-miss
   suite as ground truth and an agent-vs-harness probe-selection arm.

## Cross-idea note: the shared dynamics and the shared discipline

Ideas 3 and 4 are two views of one escalation dynamic: negotiation is
*deliberate* frog-boiling (each widening consented), drift is *unwitting*
frog-boiling (each widening unremarked). One new attacker profile in
`src/bench/tasks.ts` — incremental widening across restart cycles — serves
both, exactly as history-shaping served three economics-lens ideas. Ideas 1
and 2 both reshape the ask surface (citations vs computed evidence) and share
the uninformative-ask task classes the UX panel identified; both must face
habituation-to-their-own-intervention as a measured cell, since a dialogue
interface that gets routine is just a nicer dialog box. Governance
discipline: no frozen policy/audit schema changes — citations, evidence
blocks, and policy deltas are consumers of the existing ledger computed at
the metrics layer (sidecar JSONLs keyed by ask/decision hash); the single
product change (Idea 3's counter-offer state on the shipped y/N/s/a ladder)
needs a recorded ruling per `AGENTS.md` before implementation.
