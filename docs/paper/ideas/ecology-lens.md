# Ecology-Lens Research Ideas: Trust Between Agent Instances and Repositories

*(2026-09-13. Multi-agent-ecology sweep: federation, attestation, precedent
exchange, custody, cross-workspace transfer — the layer BETWEEN agents and
BETWEEN repositories. Each idea was surveyed against LIVE products and recent
papers before being written up; two frontier favorites were killed explicitly
at the end, one of them from our own seed list. Companion to `00-thesis.md`;
shares the apparatus — the hash-chained ed25519-signed audit log
(`src/audit.ts`: per-entry signatures, `signBlob` for arbitrary signed
statements, `buildBundle` = pubkey + `chain_tail` + entries, export refuses
broken chains), read-only depth-capped subagents on the global chain
(`src/subagents.ts`, `parentRunId` attribution), operator-only rollback
(`src/checkpoints.ts`: before-image verified, protected paths, fail-closed,
never registered as an agent tool), the decline-promotion pipeline
(`src/policy-store.ts`), and the shape grammar (`src/remember.ts`) — but
proposes NEW headline claims, not salami cuts. Prior-art discipline inherited
from `economics-lens.md`, `negotiation-lens.md`, and `systems-lens.md`.)*

**The unifying observation.** Every governance surface in this program is
single-workspace and single-instance: the grant store, the ledger, the
promotion pipeline, the precedent ladder — all adjudicate inside one repo,
under one key, for one operator. But agents live in an ecology. Repos
consume each other's artifacts (PRs, skills, shared modules, vendored
configs); agent instances delegate and hand off; operators run the same
harness across dozens of workspaces. At every one of those boundaries trust
re-zeroes: the receiving workspace knows nothing about the sending one and
starts cold. The identity layer is being productized fast (Microsoft Entra
Agent ID GA April 2026; Okta Agent SSO / Cross App Access GA August 2026) —
but identity says WHO an agent is, never WHAT ITS WORKSPACE EARNED. The
frontier below moves evidence instead of identity: signed, bounded
statements about adjudicated histories crossing workspace boundaries, and
capabilities held by the right instance.

Survey method: web searches (2026-09-13) over live products (Microsoft
Entra Agent ID, Okta Agent SSO/XAA, AgentApproved agent attestation, Rubrik
Agent Rewind, the IDE rewind surface — incumbent `/rewind`, Gemini CLI
`/rewind`, OpenCode `/undo`, Cline checkpoints, Kiro, Codex `/rewind`
request, cursor.directory / ClawHub shared-rule economies, VS Code
Workspace Trust) and 2024–2026 papers (AWCP arXiv:2602.20493; authenticated
delegation arXiv:2501.09674; compositional authorization for delegation
arXiv:2606.03518; Agent Flight Recorder arXiv:2609.01931; ACRFence
arXiv:2603.20625; AgentRewind arXiv:2608.14380; GoEX arXiv:2404.06921; AI
Control lineage + adaptive attacks on trusted monitors arXiv:2510.09462;
denylist fragility arXiv:2606.15549; defense-transfer arXiv:2502.19145;
algorithmic monoculture (Kleinberg & Raghavan, PNAS) + CSA Agent Protocol
Monoculture note (Aug 2026) + International AI Safety Report 2026; Conseca
arXiv:2501.17070; repo AI-policy landscape arXiv:2609.07542). Key sources
cited inline.

---

## Idea 1 — Letters of Credit: Bounded, Expiring Trust Instruments Between Workspaces

**Mechanism (one paragraph).** When workspace A's artifact is about to be
consumed by workspace B — a PR branch, an imported skill, a vendored module
— A can attach a **letter of credit**: a canonical, repo-key-signed blob
(`signBlob`/`buildBundle` machinery, zero schema change) committing to (a)
its `chain_tail` anchor (non-repudiable, re-verified at draw-down);
(b) a **scope** — tool classes, path prefixes, or shape families the letter
covers; (c) an **amount** — the maximum privilege class B may auto-extend
to in-scope content (e.g., `webfetch` once-class, never `bash`); (d) an
**expiry** — anchor staleness bound; (e) **beneficiary binding** — B's
public key and, critically, the ARTIFACT hash the letter covers, so the
letter pays only for the exact content it was issued against; and (f)
per-decision statistics over the covered class (decline rate, injection
hits, deny coverage) from A's ledger. B's harness consumes the letter
BEFORE the ladder: in-scope, unexpired, artifact-bound, signature-verified
content starts at a softer rung; everything from A stays cold-strict. Two
enforced properties make it governance rather than reputation: letters are
**demote-only** (a letter can never widen beyond what A's own observed
policy auto-allows, computed from the bundle), and a **draw-down** — any
single decision in B that contradicts the letter's statistics voids the
remainder, with the voiding decision hash-chained as the evidence.

**Why nobody has it — product evidence.** The identity layer shipped and
stopped exactly at the boundary. Microsoft Entra Agent ID (GA 2026-04)
gives agents first-class identities whose trust is "strong within the
tenant, bounded at its edge"; Okta Agent SSO / Cross App Access (GA
2026-08) is protocol plumbing for cross-org agent auth carrying no decision
evidence. AgentApproved markets "agent attestation" — cryptographic proof
an agent behaves as claimed, a signed certificate from runtime behavior —
the closest live product, and its gaps define the space: the attestation is
self-generated from the agent's OWN runtime, compliance-grade, issued
per-agent, and consumed as an identity check — not decision-log-derived
evidence about specific CONTENT, not bilateral, and not consumed to
modulate the receiving harness's permission ladder per artifact. AWCP
(arXiv:2602.20493) moves the workspace (temporary delegation of a projected
workspace) but not the trust. VS Code Workspace Trust is a binary local
click. Cursor/incumbent settings sharing spreads hand-written prompt rules,
never adjudicated evidence.

**Why nobody has it — paper evidence.** Authenticated Delegation
(arXiv:2501.09674) and the Compositional Authorization Framework for
Delegation (arXiv:2606.03518) formalize AUTHORITY transfer, not EVIDENCE
transfer — no adjudicated history crosses the boundary in either. The
repo AI-policy landscape survey (arXiv:2609.07542) catalogs human-authored
policy STATEMENTS in repos — unmined, unsigned, unconsumed. Agent Flight
Recorder (arXiv:2609.01931) anchors ONE chain for external verification and
does not compose chains. A2A/Entra/Okta are protocol plumbing (taken). The
web-of-trust ancestor (PGP) exchanges IDENTITY assertions, never
decision-history evidence with instrument semantics. The instrument design
space itself — scope × amount × expiry × beneficiary-binding × draw-down,
and the attacks each binding buys off — is unclaimed in both products and
papers.

**First experiment on the codewhip apparatus.** Two-repo bench: repo A runs
the seeded operator profiles over the task suite (mined policy + ledger
exist); repo B receives A's artifacts, poisoned and clean variants, under
letter arms: none / unscoped / scoped+amount / scoped+amount+artifact-
binding. Measure B's wrong-allow rate and false-block rate on
A-provenanced content (the cold-start frontier), then three attack arms:
**laundering** (A runs a clean shadow workspace that issues letters while
dirty work happens under a different identity — with vs without
artifact-binding, which should collapse laundering to re-issuance cost);
**scope-grab** (attacker routes out-of-scope actions through in-scope
content — measured as out-of-scope success per letter); **stale replay**
(expired anchor vs mutated workspace — composes with systems-lens's
mint-time witnesses). Letters are `signBlob`-signed sidecars keyed by
`chain_tail` + artifact hash; the ladder-consumption hook (Idea 1's one
product change) needs a recorded ruling per `AGENTS.md`.

**Strongest reviewer objection.** "PGP web of trust plus reputation with
different nouns — and your own economics-lens already proposed pooled repo
credit scores, so this is a salami cut of an unshipped idea." Answer: two
structural deltas and one measured object. (1) Bilateral beneficiary-bound
instruments with draw-down DISSOLVE the Sybil problem rather than solve it:
trust is extended to a named counterparty over named content, never
computed over a pseudonymous crowd — economics-lens Idea 3 itself names
Sybil resistance as its unsolved core, and the score's public scalar is
precisely what makes it farmable. (2) The measured object is the
instrument frontier — which scope/amount/expiry bindings buy cold-start
precision gains without opening laundering surface — a design-space
measurement no score paper owns. (3) The attack surface is
instrument-specific (laundering, scope-grab, draw-down gaming) and
disjoint from score-farming. The transfer half of the experiment shares
substrate with Idea 2 and is positioned as the shared foundation, not a
duplicate.

---

## Idea 2 — Herd Immunity and Policy Monoculture: The Cross-Repo Transfer Matrix for Mined Shapes

**Mechanism (one paragraph).** Mined deny/allow shapes are workspace-local;
nothing measures whether a shape mined in repo A predicts the attacks repo
B sees — yet the shared-rule economy (cursor.directory, skills hubs) is
already shipping exactly that transfer, unvetted, on the PROMPT side.
Two research moves on the PERMISSION side. **(a) Vaccination:** repo B
seeds its decline-promotion prior with A's shape-only, redacted,
chain-anchored decline bundle — does B's promotion pipeline reach
precision parity with fewer of its own adjudications (learning-curve
speedup), and WHERE does transfer break (prediction: tool-head shapes
transfer, origin-bound shapes do not — the same fault line RQ3 found
within one repo)? The ask-time interface renders sibling precedent as
statistics, not binding citations: "denied 7/10 in sibling workspaces for
this head" — the federated, aggregated, non-binding cousin of
negotiation-lens Idea 1. **(b) Monoculture:** the dark twin. If sibling
repos converge on the same mined shapes (same harness, similar operator
priors), the herd's generalization failures are CORRELATED: an attacker
who can query any one member learns the boundary of all. Measure the
monoculture collapse rate: adaptive attacker trained against the UNION of
K sibling policies vs against a single member — does union-trained
escaping beat every member at once?

**Why nobody has it — product evidence.** Shared-rule economies exist for
prompt content only: cursor.directory (a mining study of shared rules
found 28.7% of rule lines duplicated across repos — unvetted copy-paste at
scale) and ClawHub (Snyk's ToxicSkills: prompt injection in 36% of
analyzed skills). Everything shared there is INSTRUCTIONS; nobody ships
shared permission shapes — mined or hand-authored — and no harness
consumes another repo's decline history. Enterprise practice (the incumbents
settings sharing inside orgs) spreads static hand-written allowlists.
The literature uniformly treats shared rules as an ATTACK surface
(Rules File Backdoor, PoisonedSkills, ToxicSkills); the DEFENSE direction
— importing another workspace's adjudicated declines as immunity — has no
product instance.

**Why nobody has it — paper evidence.** The defense-transfer result that
frames the question exists: "attacks transfer from LLM to LLM-agents,
safety measures do not transfer" (arXiv:2502.19145, AAAI) — but it is
about model-level safety FILTERS. Mined permission shapes are
content-blind and deterministic, so cross-workspace transfer is an open
empirical question, not a foregone conclusion — the shape grammar may be
the exception that transfers, and nobody has measured it. Denylist
fragility (arXiv:2606.15549) stays within one agent's configurable
lists. Monoculture theory is mature at the wrong layers: algorithmic
monoculture (Kleinberg & Raghavan, PNAS), the International AI Safety
Report 2026's correlated-failure discussion, and the CSA's Agent Protocol
Monoculture note (Aug 2026) all operate at model/protocol/infrastructure
layer — the mined-policy layer, where the monoculture is ENGINEERED by
the harness rather than emergent from the model, is unmeasured. RBAC
mining (Xu & Stoller lineage) assumes one stable system, so transfer is
out of scope there by construction.

**First experiment on the codewhip apparatus.** K sibling workspaces
(different repo profiles: service / codegen / docs), same harness,
independent operator profiles → K mined policies. (1) The **K×K transfer
matrix**: each policy evaluated against each sibling's attack suite and
benign near-miss suite — the RQ3 held-out set is reused as the cross-repo
ground truth, so no new labels — reporting precision/recall per cell,
decomposed by shape class (which dimensions transfer, where immunity
fails). (2) The **vaccination arm**: B's promotion seeded with A's
decline bundle at 10/50/100% vs from-scratch — learning curves per shape
class. (3) The **monoculture arm**: the thesis's adaptive attacker
(build order step 3) with oracle query access to one member vs the union
of all K — attack success against the held-out member; the union-trained
minus single-trained gap IS the collapse rate. Transplant and vaccination
are consumers of the existing `remembered.jsonl` / `policy.md` formats;
ask-time precedent statistics are a sidecar keyed by shape hash — zero
frozen-schema edit.

**Strongest reviewer objection.** "Your K siblings are the SAME harness
and a synthetic operator family — of course the policies correlate, the
monoculture is baked in by construction, and transplant numbers won't
survive real diversity." Answer: harness-homogeneity is the thesis, not a
confound — the program's claim is that harness-mined policy is the
deployment future, so the exact monoculture question is "when every repo
runs this harness, what correlates"; operator-profile diversity is the
varied factor (the thesis already mandates multiple synthetic operator
profiles for external validity); and the matrix is designed to report its
own fragmentation — WHERE transfer breaks by shape class is the headline
figure, and a fragmented-transfer result is still the first measurement
of the defense-transfer question 2502.19145 leaves open at the
permission layer.

---

## Idea 3 — Capability Escrow: The Custodian Holds the Undo

**Mechanism (one paragraph).** Rollback exists and is correctly
operator-only (`codewhip rollback`: before-image verified, protected
paths, fail-closed, never in the agent's tool registry). But the operator
is the scarcest resource and the attacker's favorite absent party: a
compromised agent's damage lands in the gap between "something bad
happened" and "operator notices." **Capability escrow** mints a
custodian — a separate agent instance (own runId, own model, fresh
transcript, on the same hash-chained chain) holding EXACTLY one
capability: revert-only invocation of rollback over named runIds, with
the checkpoint manifests as its evidence. The primary CANNOT reach the
undo path (no tool), so compromise cannot destroy its own undo; the
custodian can do nothing else (read + revert only, plan-mode refusal
ladder plus one tool). Custody is enforced structurally — the capability
never enters the primary's registry — not by prompting. Three research
questions: (1) blast radius under compromise × custody arms (no-undo /
self-undo / operator-only / escrowed custodian); (2) the custodian's OWN
attack surface, inheriting the adaptive-attacks-on-monitors adversary
(arXiv:2510.09462): induced rollback of good work (rollback-DoS) and the
drink-your-own-poison problem — the custodian reads the workspace it
polices, so injected content is in its context too; (3) the new property
**evidence-preserving rollback**: codewhip's rollback never truncates the
append-only chain, so a "cleaned" state still carries the receipts —
measure reconstructability of an erased action from the ledger alone.

**Why nobody has it — product evidence.** Every shipped rewind is
operator-held: incumbent `/rewind`, Gemini CLI `/rewind`, OpenCode
`/undo`, Cline checkpoints, Kiro (which carefully distinguishes reverts
from checkpoints), Codex (`/rewind` still a feature request, issue
#11626) — or enterprise-recovery-held: Rubrik Agent Rewind markets full
causality capture (prompts, memory snapshots, tool usage → actions) with
the HUMAN operator holding authority via the recovery system. No product
gives a second agent instance the undo capability; the searcher's explicit
null — no hits for custodian/escrow/undo-key in the agent-rollback context
— stands. The `agent-safety` PyPI package ships transactional rollback as
a library with no custody model at all.

**Why nobody has it — paper evidence.** GoEX (arXiv:2404.06921) makes
undo a RUNTIME primitive (post-facto validation, damage confinement) —
custody never varies, no adversary, cited by our negotiation lens as
design-only. AgentRewind (arXiv:2608.14380) is a runtime recovery layer
checkpointing context + filesystem jointly — again no custody question.
ACRFence (arXiv:2603.20625) is the closest paper: it prevents SEMANTIC
rollback attacks (approve → one-time token → destructive act → rollback →
act again) via approval-token fencing — it secures rollback MECHANICS but
never asks WHO HOLDS the revert or whether the compromised principal can
reach its own undo. The AI Control line (Greenblatt et al.; trusted and
untrusted monitoring) and its adaptive-attack sequel (arXiv:2510.09462)
give monitors VERDICTS (escalate to a human) but never CAPABILITIES —
oversight without custody. Separation of duties is classical RBAC between
human roles; between two agent instances sharing one append-only ledger,
with the custody asymmetry as the measured object, it is unclaimed. Our
own audited-subagent composition claim covers children ON the chain, not
children holding capabilities against the parent.

**First experiment on the codewhip apparatus.** The bench's compromise
cells (injected agent profile) × four custody arms. The custodian reuses
`runChildAgent` with a single new `revert(runId)` tool gated behind
plan-mode (checkpoint manifests are already keyed by runId+seq on the
chain; the revert tool registration is the one product change needing a
recorded ruling). Metrics: (1) residual damage at detection per arm —
files written / endpoints contacted before any revert (prediction:
escrow beats operator-only on latency and beats self-undo on laundering,
at a benign-cost premium); (2) **laundering success**: attacker-induced
self-undo in the self-undo arm vs custodian arm, and reconstructability
of the erased action from the ledger + `parentRunId` attribution alone —
the falsifiable claim that chain-preserving rollback makes self-undo
pointless; (3) **rollback-DoS**: attacker-forced false reverts of benign
work, with custodian model-family diversity (the AI Control
trusted/untrusted split, operationalized) as a measured lever; (4) benign
cost: false-revert rate and revert-thrash on continuation tasks — the
RQ4-style frontier for custody. Wilson intervals, McNemar vs
operator-only.

**Strongest reviewer objection.** "You added a second model that reads the
same poisoned workspace — you doubled the attack surface and called it a
defense; AI Control already showed adaptive attackers subvert monitors, so
the custodian buys nothing asymptotically." Answer: structural custody
changes the FAILURE MODE, not the compromise probability. A subverted
custodian can only revert — its worst case is the operator's status-quo
worst case (lost work, recoverable from git), while a subverted SELF-undo
is laundering (erased evidence, unrecoverable without the chain). That
asymmetry is the contribution, and it is quantified: the
drink-your-own-poison cell MEASURES the custodian's subversion rate
rather than assuming it, with model diversity as a measured arm; and
reconstructability-from-chain is a guarantee neither GoEX, AgentRewind,
nor ACRFence states or tests — if induced rollback can produce a state
that is both clean on disk and unreconstructable from the ledger, that
negative result bounds every rollback-based defense in the runtime line.

---

## Killed ideas (with the evidence that killed them)

1. **Peer verification of decision logs without a central authority
   (gossip / witness cosigning / anchoring between sibling chains) —
   KILLED.** Occupied at the mechanism level while this lens was being
   scouted: Agent Flight Recorder (arXiv:2609.01931, Sept 2026) already
   compares anchoring mechanisms for agent audit trails and identifies
   on-chain anchoring as the option "requiring no pre-agreement, allowing
   any party to verify given the disclosed payload and proof" — the exact
   decentralized-verification claim. The generic layer beneath
   (Certificate Transparency, Sigstore Rekor, key transparency, WORM /
   ledger storage) is old and productized; FinQub's compliance survey
   already lists CT/Sigstore as what examiners accept. The residual
   delta — anchoring cadence as a detection-latency/cost tradeoff — is an
   engineering parameter, not a paper. Salvage: the anchor-exchange
   fragment (a letter's `chain_tail` must be re-verified at draw-down, so
   bilateral verification rides inside Idea 1 as non-repudiation
   machinery), and the local truncation half stays with systems-lens
   Idea 1, which already notes export is the external anchor.

2. **Agent-authored policy proposals with formal evidence (the agent
   PROVES a deny is safe by replaying against past outcomes) — KILLED.**
   Two-front squeeze. First, the agent-authored-policy lane is occupied:
   Conseca (arXiv:2501.17070, "Contextual Agent Security: A Policy for
   Every Purpose," Tsai & Bagdasarian, ACM) generates contextual security
   policies on demand with an automated toolchain for constructing and
   refining them — agent-authored policy is the premise there, not the
   gap — and SafeEvolve (arXiv:2609.02786) already converts trajectories
   into "bounded, auditable harness updates." Second, the "formal
   evidence" half is our own systems-lens Idea 1(b) (flip-set backtesting
   of policy mutations against the adjudicated history) wearing a proposer
   costume, and the proof-carrying frame is independently crowded
   (Certified Traces / Permissibility Machines arXiv:2605.24462, PCA for
   LLM agent runtimes, Certificates of Validity arXiv:2606.23768 —
   systems-lens kill 2's evidence stands unchanged). Residual: an
   adversarial proposer gaming the certificate verifier (minimal-flip
   proposals from a compromised agent) is one bench arm, not a standalone
   claim — noted as a possible extension arm for systems-lens Idea 1's
   quiet-edit cell rather than an ecology paper.

## Cross-idea note: one substrate, two shared measurements, one discipline

Ideas 1 and 2 share the K-sibling bench harness: Idea 1 consumes pairwise
letters, Idea 2 computes the full transfer matrix — one apparatus
addition (sibling workspace generation in `src/bench/`) serves both, as
history-shaping served three economics-lens ideas. Idea 3 shares the
thesis's adaptive-attacker infrastructure (build order step 3) and adds
one new profile — the induced-rollback attacker — disjoint from the
negotiation-lens incremental widener, the economics-lens budgeted
escalator, and the systems-lens quiet-editor (no shared profile, no
shared claim). Governance discipline per `AGENTS.md`: all three ideas are
ledger/policy CONSUMERS — letters are `signBlob`-signed sidecars keyed by
`chain_tail` + artifact hash, transplant/vaccination ride the existing
`remembered.jsonl` / `policy.md` formats, escrow reuses checkpoint
manifests; two product changes need recorded rulings before
implementation: the `revert` tool registration for child runners (Idea 3)
and letter-consumption in the preflight ladder (Idea 1). Positioning
discipline: Entra/Okta/XAA/A2A are identity and protocol plumbing
(taken) — every idea here moves EVIDENCE and POLICY SEMANTICS, never
protocol; the named adjacents from our own program (economics-lens Idea 3
pooled scores, negotiation-lens Idea 1 local precedent, systems-lens
Idea 1 replay, our audited-subagent claim) are cited inside each idea
with the delta stated, so no reviewer can read this as salami-cutting
our own apparatus.
