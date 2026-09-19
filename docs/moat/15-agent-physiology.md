# 15 — A Physiology of Agent Harnesses (paper scaffold)

**Status: scaffold only. The paper track is CLOSED** (user ruling 2026-09-18:
"paper later entirely" — reopened for *framing* only). This doc records the
view so a session crash doesn't redo the analysis. Reopen triggers are at the
bottom and are binding.

Frame decision (user-selected from three candidates): **physiology umbrella**,
beating immune-only (occupied by AgentAntibody for prompt injection) and
metabolism-only (too narrow; adjacent work exists).

---

## 1. Thesis

The LLM is the nervous system — cognition, planning, language. It is not the
organism. Everything that keeps an agent alive in a hostile, budgeted,
unreliable world lives in the *harness*: the loop, the policy engine, the
router, the compactor, the memo, the process killer.

The strongest survey in this field concedes the gap directly: because AI
agents "don't have a body with physiology, they lack an equivalent of the
autonomic nervous system" (*Advances and Challenges in Foundation Agents*,
arXiv 2025). Our claim inverts that: **the harness is that autonomic layer,
and it can be dissected, named, and measured like physiology.**

An analogy alone is a blog post. The rule that makes this a paper:

> **Every mapping must bind three things: a mechanism that exists in the code
> (file:line), a metric that can be computed from run artifacts, and a
> falsifiable claim. Mappings that can't bind all three are supporting cast
> or cut.**

## 2. Mechanism → organism mapping

| Harness mechanism (anchor) | Organ system | Literature anchor | Metric / falsifiable claim |
| --- | --- | --- | --- |
| Context ceiling `min(60k, 0.7 × contextWindow)` — `src/index.ts:735-738`; per-provider `contextWindow` — `src/provider-registry.ts:192` | **Metabolic ceiling** / allostatic load. Provider class = metabolic rate (8k relay vs 200k model) | Selye's allostatic load; dose-response curves | Task success collapses *non-linearly* past a utilization fraction ρ*, and ρ* differs by provider class. (This is the fixed `--free` death: 8k relays died in terminal 400s before the 60k gate fired.) |
| Compaction with CJK-aware `weightedLength` — `src/compact.ts:49,96` | **Sleep-dependent memory consolidation** / synaptic downscaling | Tononi & Cirelli (SHY): renormalization preserves signal while cutting energy | An optimal consolidation *frequency* exists: too rare = overflow death, too frequent = gist loss. Ablate prune-only vs summarize+prune vs frequency sweep. |
| Subagent budget partition: 85% children / 15% coordination, **uniform** per-child split — `src/budget.ts:16,34`; wired in `src/tools/delegate_many.ts:92-118` | **Allometric scaling** / resource partitioning | Kleiber's law (1932): metabolic rate scales sublinearly with mass | **The open law**: optimal split is sublinear in child weight, `b_i ∝ B·w_i^α` with α ∈ (0,1). Shipped code is the α=0 (uniform) baseline. No prior measurement of this exponent exists (checked 2026-09-18). |
| Repeat memo: `REPEAT_NUDGE_AT=3` — `src/loop.ts:41`; memo serve + nudge — `src/loop.ts:753-767`; redact-before-store — `src/loop.ts:816`; cleared on edit/write/bash | **Habituation / dishabituation** (non-associative learning) | Kandel (Aplysia): decremental response to repeated stimulus; reset on novel stimulus | Memo-on reduces redundant tool tokens at bounded staleness risk; the correct dishabituation predicate is *structural change* (edit/write/bash invalidates cached reads). Ablate memo-off vs memo-on; count wasted-repeat tokens and staleness errors. |
| Static policy: spelling-normalized token matching — `src/policy.ts:45`; interpreter class — `src/policy.ts:190`; brace-rule — `src/policy.ts:98`; ladder precedence; jail secret net — `src/tools/jail.ts:36`; self-protected paths incl. `policy.md` — `src/checkpoints.ts:39` | **Innate immunity**: skin/mucosa (jail barriers), pattern-recognition receptors (denylist), complement (chain guards) — present at birth, fast, non-specific, non-adaptive | Janeway's PRR model; Forrest/Hofmeyr negative selection (1994) | Two measurable arms: **escape rate** (adversarial command suite bypasses the net) and **autoimmune rate** (legitimate commands denied on real tasks). The engineering tradeoff is a curve, not a point. |
| One-approval-per-run for self-protected paths — `src/loop.ts:702-711`; promoted rules live in `policy.md` | **Self-tolerance**; the germline genome | Immune tolerance; selection pressure → genome | `policy.md` is the heritable layer; declines are the selection pressure. (Metric belongs to C3 below.) |
| Failover: pre-resolved `rotationTargets` — `src/loop.ts:338`; bounded ledgers (`waitedOnce` — `src/loop.ts:324`, `nextRotation` gate — `src/loop.ts:494`); `/model` via `takePendingSwitch` — `src/loop.ts:396`; FREE_CHAIN — `src/free-chain.ts:56` | **Homeostasis** (Cannon): negative feedback restores setpoint; error signals (429/timeout/auth) as inflammation; rotation as chemotactic recruitment of spare capacity; `/model` = deliberate prefrontal override of autonomic routing | Cannon (1929); danger-signal recruitment (C3's tie-in) | **Fault-storm survival rate**: task completion under injected 429/timeout/auth storms vs single-provider baseline, plus routing overhead cost (latency/token tax of resilience). |
| `treeKill` process-tree kill — `src/tools/background.ts:123,169`; timeout backstop — `src/background.ts:159` | **Apoptosis** (contained, programmed death) vs **necrosis** (leaky death) | Kerret al. apoptosis/necrosis distinction | Small but vivid: pre-fix, every timed-out backgrounded dev server leaked its port — necrotic death. Post-fix death is contained. Metric: leaked-process count on timeout. |
| Checkpoints + rollback — `src/checkpoints.ts` | **Dauer / spore dormancy**: viable suspended state, resumable | C. elegans dauer entry/exit | Supporting cast. Metric would be rollback-restoration fidelity. |
| Subagents: children read-only, no network, no delegation (delegate/delegate_many specs) | **Terminal cell differentiation**: potency loss as a safety property | Stem-cell potency hierarchy | Supporting cast: capability restriction = differentiated phenotype. |
| Audit chain + signed genesis (`src/audit.ts`) | Self-verifying ledger | DNA proofreading | Supporting cast. Considered as "immune memory registry" and **demoted** — no metric binds to it. Example of the rule in §1 working. |
| Decline-mining (deferred; not yet built) | **Adaptive immunity via danger theory**: Signal 1 = near-miss pattern surfacing in the policy engine; Signal 2 = one-bit human decline in context; **both together** induce a memory rule | Matzinger's danger model (1994); two-signal co-stimulation; Yang 2014 AIS survey (DTA) | This is C3 below — the flagship the frame grows into. |

## 3. Prior art & positioning

Checked 2026-09-18. Exact arXiv IDs marked ⧗ get pinned at paper-write time.

- **AgentAntibody: An Adaptive Immune System for Defending LLM Agents** (S. Weng et al., arXiv 2026 ⧗) — occupies *immune-frame-for-prompt-injection* with evolutionary antibodies. Not a kill shot: it validates the frame and gives us a mandatory citation. Our differentiation is two-fold: (a) harness-level **tool-permission learning from one-bit human declines**, not injection antibodies; (b) full-organism metrics, not a single defense module.
- **Biological Motifs for Agentic Control: A Typed Interface** (arXiv:2607.04240) — closest frame neighbor: biological motifs incl. autoregulation/homeostasis, "agent graph as organism". **No metrics, no measurements** — design vocabulary only. We must cite and differentiate, not claim the frame wholesale.
- **Advances and Challenges in Foundation Agents** (arXiv 2025 ⧗) — the hook citation: agents lack "an equivalent of the autonomic nervous system". Our thesis answers it.
- **Intelligence Entropy / ADE Stability Engineering** (arXiv:2606.18065) — "cognitive homeostasis" for long dialogues; stability-engineering neighbor on the homeostasis axis.
- **Towards Open Complex Human–AI Agents** (arXiv:2505.00018) — Living Systems Theory position paper; systems theory, no physiology metrics.
- **Allostatic agents** (Khan et al. 2024 ⧗) — internal physiological parameters (Energy, Socialness) with allostatic control; nearest neighbor on the metabolism axis.
- **BAMAS** (arXiv Nov 2025, AAAI 2026 ⧗) and **Self-Resource Allocation in Multi-Agent LLM Systems** (arXiv:2504.02051) — budget-aware MAS structuring, formalized allocation objectives. Neither measures a scaling exponent. Plus **Scaling Behavior of Single LLM-Driven MAS** (2026 ⧗) — MAS scaling laws, no per-child budget allocation.
- **Classic AIS literature** (pre-LLM, 30 years): Matzinger's danger model (1994; Pradeu 2012 retrospective), Yang 2014 AIS intrusion-detection survey (Danger Theory Algorithm), Forrest/Hofmeyr negative selection (1994). We inherit vocabulary, baselines, and a referee community (ICARIS) — the immune chapter stands on old bones, which is a strength.
- **Harness engineering surveys / A Taxonomy of Agent Harness Failures** (Greyling 2026 ⧗) — establishes harness-as-subject is publishable; no physiological-metrics systematization exists anywhere yet.

**Open-slot summary**: umbrella-frame-with-metrics = open; allometric exponent for subagent budgets = open; danger-theory permission induction = occupied-adjacent (differentiate).

## 4. Contributions (each: hypothesis → metric → experiment → cost)

### C1 — Physiological robustness metrics + stress-test (position + empirical)
- **Claim**: harness quality is measurable as physiology: three families of metrics — (a) *compaction survival curves* (task success vs context utilization, per provider class), (b) *fault-storm survival rate* + routing overhead (homeostatic resilience), (c) *escape/autoimmune tradeoff curve* (immune coverage).
- **Experiment**: stress-test protocol any harness can run — inject provider faults, replay adversarial command suites, replay real tasks while sweeping the compaction ceiling. Run it on codewhip first; OpenCode/Crush comparisons make it a benchmark paper.
- **Cost**: fault-injection harness + adversarial suite don't exist yet; medium. Grows directly out of the eval harness built 2026-09-17.

### C2 — Kleiber test for subagent budgets (the empirical spine; opens first)
- **Claim**: optimal per-child token allocation is sublinear in child weight, `b_i ∝ B·w_i^α`, α ∈ (0,1) — the allometric law; uniform split (α=0) and proportional split (α=1) are both beatable.
- **Experiment**: sweep α ∈ {0, 0.25, 0.5, 0.75, 1} over the eval fixture tasks using `delegate_many` fan-outs (parallel implement-class tasks where weights differ most). Measure success rate + allocated-but-unused token waste. Shipped `src/budget.ts` *is* the α=0 arm — the baseline is already in production.
- **Cost**: low — eval harness + allocation knob exist; needs real-provider eval numbers first. **This is the law nobody has measured.**

### C3 — Adaptive immunity: policy induction from one-bit human declines (flagship growth path)
- **Claim**: two-signal co-stimulation (near-miss pattern **and** human decline, both required — prevents noise poisoning) can induce permission rules that cut escape rate at bounded autoimmune cost.
- **Metrics**: escape rate ↓, autoimmune rate ≤ ε (legit-command denials), acquisition cost (declines-to-coverage).
- **Needs**: decline-mining harness + escape-rate telemetry (recorded as deferred in `torvalds-architecture-review.md`). 3–6 months. Cite and differentiate AgentAntibody.

## 5. Honest verdict

Consistent with the five-simulation review (`torvalds-architecture-review.md`):
**no A* claim today, and the analogy is not the contribution.** The paper exists
only where the frame touches measurable law: C1's metrics + C2's exponent is a
credible workshop/short paper; C3 is the flagship it grows into after the
deferred telemetry exists. The umbrella frame's job is to make three scattered
mechanisms (memo, rotation, compaction, budget) read as one *system* — that is
the "interesting view", and it costs nothing while the track is closed.

## 6. Venue map

- arXiv position paper first (fast, timestampable).
- **ICSE-NIER / SEIP** — empirical SE angle for C1+C2.
- **ICARIS** (Int. Conf. on Artificial Immune Systems) — natural referee pool for C3; the AIS community has wanted a post-2019 application killer.
- **AAAI/ICML agent workshops** — C2 as a standalone empirical note if results are crisp.
- C1's growth path: a cross-harness physiological benchmark.

## 7. Reopen triggers (binding on future sessions)

The paper track reopens only when **all three** hold:

1. Real eval numbers exist — `codewhip eval` has been run against real providers; the ≥70% polish / ≥50% implement bars have measured values, not placeholders.
2. The 90-day frame decision (team delegation vs $0 on-ramp) is recorded in `10-competitive-reality.md`.
3. The measurement telemetry is scoped or built: allocation-experiment runner (C2) and fault-injection harness (C1b).

Until then: this doc is the recorded view; build order stays in `docs/roadmap.md`.
