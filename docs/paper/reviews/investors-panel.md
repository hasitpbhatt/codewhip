# Investors panel review — commercial positioning of "One Yes Is Forever"

**Panel:** 5 voices — (1) dev-tools VC, (2) agent-infra VC, (3) open-source strategy
veteran, (4) enterprise security buyer advisor, (5) skeptical public-markets quant.
**Reviewed:** docs/paper/00-thesis.md (2026-09-13 reframe), README.md, SOUL.md,
docs/roadmap.md, docs/moat/00-convergence.md, and the three prior reviews
(researchers-panel.md, engineers-panel.md, security-panel.md). The paper is a
skeleton: results pending, cross-agent harness unbuilt, no disclosure machinery.
**Date:** 2026-09-13

---

## Voice 1 — Dev-tools VC (category formation)

"Trusted agent harness" is a **feature today, not a category** — and features are
what incumbents absorb in one release. Anthropic ships permissions; OpenCode ships
permissions; a "governance" checkbox is a roadmap item for both. Categories get
claimed by *distribution + a paid wedge*, and codewhip has neither yet: MIT
open-source, solo builder, and the house kill list explicitly defers the SSO /
enterprise bundle / compliance-deck GTM to H2 (convergence ruling + kill list item
5). The paper therefore creates **narrative capital with no commercial surface to
land it on** — demand generation for a paid tier that doesn't exist.

But the narrative is genuinely good, and that matters. "One yes is forever" — the
insight that a single semi-attentive keystroke mints *durable* privilege inside the
incumbents' approval stores — is a demo-day-grade enemy. If the attack-success
numbers land, the wedge story writes itself: *we measured the persistence surface
across N real agents; every product with an "always allow" mechanism is exploitable
from one in-repo file; we're the harness that survives the restart.* That is a
category-opening sentence — it reframes competitors' permission UX as a measured
vulnerability class rather than a feature gap.

The specific result an enterprise would eventually pay for: **durable-privilege
rate ≈ 0% under adaptive injection, with a signed, replayable receipt trail.** Not
the paper — the attestation behind it. Which means the timing answer is: the paper
is H2 demand generation; H1's only job is to make the meter and the trust story
real so there is something to buy when the paper lands. Don't let a paper ship a
promise the product can't yet cash.

## Voice 2 — Agent-infra VC (defensibility and diligence)

What I'd diligence is not the paper, it's the **assets the paper forces into
existence**: (1) the measurement corpus — attack payloads × products × versions ×
decision logs, which no lab can shortcut without doing unglamorous per-product
driver work; (2) the mined-shape generalization data (RQ3, the researchers panel's
"quantitative heart nobody has published"); (3) vendor acknowledgments/CVEs, which
are third-party validation money can't buy. Those compound. A PDF doesn't.

Diligence red flags I'd raise in the first meeting:

- **Conflict of interest.** Own defense, own bench, no external baseline. The
  researchers panel already flagged it; a technical buyer will too. The paper needs
  at least one external defense (CaMeL-style, spotlighting, Progent) evaluated on
  the same suite, or the defense half reads as marketing with citations.
- **The self-own window.** The security panel found code-level bypasses in *every
  layer the thesis offers as the contribution* — the curated allowlist mints the
  attacker's exfil and RCE primitives, the origin grant ignores redirects,
  promotion provenance is cosmetic, the ledger is tail-truncatable. Publishing a
  measurement paper while your own defense fails your own (unpublished!) suite is
  brand destruction with a deadline. The fix must precede the measurement; the
  measurement must precede the marketing.
- **The bench as CI is the actual productizable.** Vendors pay for regression
  infrastructure, not for papers. A `persist-safe` gate — "your harness release
  didn't regress on the persistence suite" — is a tooling purchase with a budget
  line. That's the closest thing to a business here, and it's also the artifact
  that makes the paper reproducible rather than anecdotal.

## Voice 3 — Open-source strategy veteran (ecosystem relations)

The multi-vendor study is the highest-leverage and highest-risk asset in the repo,
and the difference between asset and liability is **process discipline**, not
results:

**Asset path.** Dated coordinated disclosure (90-day norm) agreed *before* the
first cross-product run; per-vendor private writeups that explicitly separate
grant-persistence (the authority store poisoned by the operator's own approval)
from the already-published rules-file content story (CVE-2025-54136) so vendors
don't triage you as a duplicate; publication with **aggregated rates + CVE
identifiers**, never a vendor-named leaderboard; the harness offered privately to
each vendor as a hardening tool; a "persist-safe" badge vendors can *earn*, not a
score they're assigned. That's how research-as-distribution works for OSS: the
disclosure becomes relationships, the relationships become the badge program, the
badge program becomes the standard. OpenCode and Aider are communities you want
embedded in — handled this way, they become your first external bench adopters.

**Liability path.** Publishing per-vendor attack rates before patches land;
marketing that says "vendor X is 84% hackable"; adaptive-attacker artifacts leaking
for unpatched products; or any run that isn't hermetic — the security panel is
right that an adaptive attacker against a real agent with real keys in env is
*researcher self-exfiltration*, and one ToS violation or leaked key converts a
credibility asset into a legal incident and a community ban. Also note the house
rule: findings go in `docs/moat/`, build order in `docs/roadmap.md` — a paper with
its own private build order is a shadow roadmap; mirror it or it will drift.

The dev-facing essay ("One Yes Is Forever", one 2am demo, `codewhip demo` runs
offline at $0) will outperform the PDF for OSS distribution. Write the PDF for the
reviewers; write the essay for the people who install things.

## Voice 4 — Enterprise security buyer advisor (what gets bought)

Nobody in my buying center purchases a paper, a threat model, or "trust." They
purchase **artifacts that satisfy an auditor and a budget memo**. Map what exists:

| Buyer need | Codewhip today | The paper's role |
|---|---|---|
| Threat narrative to get budget | none | "Our agents' approvals persist across sessions — measured: [rate]" is the CISO memo that funds agent governance |
| Evidence for auditors | signed audit export, receipts, rollback | SOC2 CC7/CC8 mapping (H2 backlog); the bench adds "and we test the control against attack cells" |
| Attestation | `codewhip trust` (chain/policy/gate/memory/keys, `--json`) | Extend with a bench-derived persistence score; that's the certificate with teeth |
| Compensating controls | policy packs, CI action, `--plan` | paper proves deny-rules pre-flight beat prompt-stated policy (RQ1) |

The one result a buyer pays for is the **attestation bundle**: persistent-privilege
rate ≈ 0% under injection, Wilson intervals, on a signed audit trail, exportable
and replayable — priced into the planned $40/team tier. The paper is the funnel,
the certificate is the product.

Liabilities from where I sit: a multi-vendor attack study can *spook procurement*
("their bench runs agents with real keys?") unless hermeticity, IRB determination
for the operator study, and redaction discipline are stated publicly and plainly —
scrubbed JSONL, no customer data, no real secrets in artifacts. And one subtle
one: if the study names products our auditors use, procurement asks *them* about
it before they've patched. Aggregated-until-patched isn't just ethics, it keeps
the buyer conversation calm.

## Voice 5 — Skeptical public-markets quant (base rates and kill math)

Base rate honesty: papers → enterprise revenue is a weak conversion. The dev-tools
companies that won on research won because the research shipped *as an artifact
people ran* (a benchmark, a CLI, a badge), not as a PDF. Meanwhile the opportunity
cost is severe and quantifiable in this repo's own terms: the launch gate
(polish <$0.05 with receipts) blocks *all* public activity by house law
(convergence ruling 5), the north-star metric is trusted runs/team/week, and
today there are zero pilot teams. Every week on the paper is a week not closing
a gate that outranks it.

So I'll only fund attention on this lane if it produces **measurable leading
indicators**, and I want the kill criteria written down before the work starts:

- **Field kill:** cross-product runs show durable-privilege rate ≈ 0% everywhere
  (the vulnerability doesn't exist in the field) → no wedge, no paper, stop.
- **Self kill:** codewhip's own persistent-privilege or exfil success > 0 after
  the security fixes land → the defense half is dead; keep the bench as a tool,
  drop every "trusted harness" claim.
- **Citable kill:** the persistence metric is still confounded and no headline
  number with Wilson CIs exists ~6 weeks from starting the cross-agent harness →
  it's an academic detour for this company; stop.
- **Market kill:** 90 days after the artifacts ship: zero vendor confirmations
  (CVEs or hardening changes), zero external bench adoption, zero pilot-team
  conversations attributable to the paper → stop.
- **Cost kill:** paper time exceeds ~25% of builder time while the polish gate is
  still OPEN at any 30-day check → re-prioritize to the gate. House law wins.

One more quant note: the apparatus receipts gap (bench drops usageByModel / model
mix / $) means the paper currently violates the repo's own definition of done on
its own runs. That's a credibility tell — fix it before any external eye.

---

## Consensus

**The paper is not an academic detour — but only if it ships as artifacts, not as
a PDF.** As prose, it's a detour with negative tail risk (self-own if the defense
fails its own suite; vendor blowback if disclosure is sloppy). As an artifact
chain — bench CLI → disclosure program → CVE-backed results → extended trust
certificate → paid team tier — it is the cheapest category-narrative asset this
repo can build, because it forces the product's own claims through an adversarial
ringer and produces third-party validation (CVEs, acknowledgments) that no
incumbent can fake.

On the five questions:

1. **Commercial value:** conditional. The one result a buyer pays for is the
   attestation — durable-privilege rate ≈ 0% under adaptive injection with a
   signed, replayable receipt trail — monetized via the H2 paid tier and the
   pack registry, not via the paper. The paper's direct value is the CISO budget
   memo and the vendor confirmations.
2. **Category vs feature:** a feature today. It becomes a category only if the
   numbers land AND vendor confirmations exist AND the badge/certificate gets
   third-party adoption AND a paid surface exists to catch the demand. The wedge
   narrative if the numbers land: *"One yes is forever — we measured it across
   N real agents; only one harness survives the restart."*
3. **Disclosure: asset or liability** is decided by process, not results. Asset:
   dated coordinated disclosure before first run, per-vendor writeups separating
   grant-persistence from the CVE-2025-54136 content story, aggregated publication
   with CVE ids, private harness offers, hermetic containerized runs. Liability:
   vendor-named leaderboard pre-patch, leaked artifacts, any non-hermetic run,
   ToS violations.
4. **90-day reinforcement (concrete artifacts):** the bench as a standalone
   npx-runnable service with manifest + receipts + CIs; `codewhip trust --json`
   extended with a bench-derived persistence score (the certificate with teeth);
   the dev-facing essay + offline `codewhip demo` for distribution; the disclosure
   program as a tracked workstream, mirrored into `docs/roadmap.md` — not a shadow
   roadmap inside the paper.
5. **Kill criteria:** the five above (field / self / citable / market / cost).
   The field kill and the self kill are the existential ones; the rest are
   opportunity-cost discipline.

## Top 3 recommendations

1. **Fix the defense before the measurement.** Land security-panel must-fix #1
   (re-curate memorable heads, pin webfetch redirects to the granted origin, make
   promotion provenance real, close the bash side doors) before the adaptive
   attacker or any cross-product run. Non-negotiable sequencing: defense survives
   its own bench → hermetic cross-agent harness → disclosure → publication. The
   paper must never be published while codewhip fails its own suite.
2. **Ship the bench as a product artifact in the next 90 days, timeboxed.**
   Standalone `codewhip-bench` (npx-runnable, run manifest, Wilson CIs, receipts
   per the definition of done) + `codewhip trust --json` gains a persistence
   score. Success bar: one citable headline number (cross-product
   durable-privilege rates with CIs) and ≥1 external user of the bench. Miss the
   ~6-week citability bar and the paper lane is dead by its own criteria.
3. **Run disclosure as a program with a kill switch.** Vendor contacts and a
   dated 90-day timeline committed *before* the first cross-product run;
   per-vendor writeups separating grant-persistence from the rules-file CVE line;
   publish aggregated + CVE-backed results only; never market "vendor X is
   hackable"; review the five kill criteria at day 30/60/90 and stop on any hit.
   Mirror the paper's build order into `docs/roadmap.md` — the house's
   no-shadow-roadmap rule applies to papers too.
