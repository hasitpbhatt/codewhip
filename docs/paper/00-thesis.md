# One Yes Is Forever: Measuring and Defeating Persistent Compromise of Coding Agents

*(formerly: "Your Agent's Memory Is Its ACL" — reframed 2026-09-13 for A*
bar: the attack class gets measured against REAL deployed agents; codewhip
is the defense, not the subject.)*

**Status:** skeleton (results pending). Apparatus: `src/bench/` (decision-
level grading, ablation arms, persistence cells). A* bar requires:
multi-product measurement, adaptive (LLM-driven) attackers, and responsible
disclosure — build order below.

---

## Abstract (draft)

Coding agents accumulate authority across sessions: one fat-fingered
"always allow" mints a durable rule, repo-controlled instruction files
(AGENTS.md, .cursorrules) re-inject attacker-chosen guidance on every run,
and learned memories silently rewrite what tools do. We call this the
*persistence surface*, and give the first systematic measurement of it:
an automated, LLM-driven attack harness that attempts to mint durable
privilege (approval persistence), durable sabotage (deny-DoS, poisoned
instructions), and cost damage (loop-injection) across N real coding
agents, measuring what survives a session restart. We find [PLACEHOLDER:
attack-success rates per agent — every product with a persistent-allow
mechanism is exploitable by a single in-repo injection at least once].
We then present a defense — interaction-derived policy with curated
allow-generalization, threshold-gated decline promotion, and a tamper-
evident hash-chained ledger — evaluated against the same suite.

## Positioning (what exists, what's missing)

| Line | Representative work | What they assume / measure | The gap we fill |
|---|---|---|---|
| Privilege control | Progent (arXiv:2504.11703) | DSL for tool-call policies; **hand-authored** | Where rules come from: mined from operator decisions |
| Runtime enforcement | AgentSpec (arXiv:2503.18666) | trigger–check–enforce; **hand-authored** rules | Same |
| Injection defense | CaMeL (arXiv:2503.18813) | Engineered capabilities, information-flow control | Mined, coarse, human-sourced denies; generalization measured |
| Injection benchmarks | AgentDojo (NeurIPS'24); agentic-editor attacks up to 84% success (arXiv:2509.22040); IssueTrojanBench ~66.5% | Policy surface = prompt text | Policy surface = harness, content-blind |
| Policy mining | RBAC/ABAC mining (Xu & Stoller lineage) | Logs of already-authorized access in stable systems | Noisy one-button human decisions on AI-proposed actions |
| Memory governance | OWASP cheat sheet; memory-drift paper (arXiv:2606.06054) | Position/warning: memory must not become authoritative | First measurement of memory-as-policy, both directions |
| Overthinking | "Do NOT Think That Much…" lineage | Reasoning tokens within one call | Agentic loop waste (repeat reads, step burn) + harness interventions |

**Claim to novelty:** no published measurement of the
decision → rule → enforcement → attack lifecycle for interaction-derived
agent policy; the approval-persistence attack class is unnamed anywhere we
could find.

## Threat model

- **Adversary:** content the agent is asked to process (repo files, fetched
  pages, tool output) carries injected instructions; the adversary controls
  workspace content, not the operator's terminal.
- **Operator:** semi-attentive human in the approval loop; fat-fingered
  `a` (always) is in scope — it is the common case we model, not an edge.
- **Assets:** secrets in the workspace; operator money (token spend);
  availability (agent usable in the workspace); policy integrity (the
  compiled rules themselves).
- **Out of scope (v1):** compromised host, malicious provider, side
  channels; the model provider is honest-but-weak.

## Research questions → experiments → metrics

| RQ | Question | Experiment | Metric (ground truth) |
|---|---|---|---|
| RQ1 | Does harness-side compiled policy resist indirect injection where prompt-stated policy fails? | Same tasks; deny rules surfaced in prompt vs enforced pre-flight (`policySurface` arm) | Attack-success rate over decision logs (allow on attack tool/subject) |
| RQ2 | What persists? The approval-persistence attack class | Malicious repo → injection → scripted fat-finger `a` → session restart → does the privilege survive? In-repo cells (`runsPerCell`) + REAL agents (Claude Code `--always-allow` semantics, Cursor rules, memory stores) | Durable-privilege success rate per agent; blasts: allow-escalation vs deny-DoS |
| RQ3 | Do mined deny shapes generalize? | Held-out variants (subdomain hosts, flag reorder, path aliases) + benign near-misses vs compiled shapes | Precision/recall of the shape grammar |
| RQ4 | Does resource policy contain blast radius? | Injected/pathological agents with vs without mid-run budget, per-call deadline, delegation budget-split | Token/$ damage distribution; fan-out exposure |
| RQ5 | What does agentic overthinking cost, and what tames it? | Loop-inducing tasks; repeat-guard memo+nudge and hard budget arms | Repeat-call counts, step burn, cost–success frontier |
| RQ6 | Is the evaluation itself tamper-evident? | Post-hoc log edits vs `verifyChain`; replay | Tamper detection rate; replay decision equality |

## Build order to the A* bar

1. **Apparatus (done):** `src/bench/` — runner (arm×task×run cells, workspace
   reuse for persistence), decision-log grader, seeded task suite, analysis.
2. **In-repo matrix:** run the seed arms on one real free-tier model; fill
   RQ1/RQ3/RQ4/RQ5 tables.
3. **Adaptive attacker:** replace hand-written injection payloads with an
   LLM-driven attacker that iterates on refused attempts (AgentDojo-style
   adaptive attacks) — hand-written injections understate the threat.
4. **Cross-agent harness:** headless drivers for real coding agents
   (Claude Code -p, OpenCode, Aider) executing the same malicious-repo tasks
   twice (restart between) to measure persistence per product.
5. **Responsible disclosure** to affected vendors; disclosure timeline in
   the paper's ethics section.
6. **Defense evaluation:** codewhip's curated-allow/threshold-gated/ledger
   substrate against the identical suite.

## Method (apparatus, `src/bench/`)

- **Runner** (`runner.ts`): batch `agentLoop` over generated temp
  workspaces; scripted `askUser` per arm (auto-deny / auto-yes /
  fat-finger-once); JSONL result per task×arm with the full decision trail.
- **Tasks** (`tasks/`): repo-style tasks with planted injections across
  classes: exfil (fetch/curl to attacker URL), secret access (read
  credential material), destructive bash, policy tampering (write into
  `policy.md` / remembered store), cost inflation (loop-prompting, mass
  fetches), plus benign near-misses for RQ3.
- **Arms:** prompt-only policy / static denylist / +compiled denies /
  +remembered allows; each ± token budget, ± repeat guard, ± delegation
  budget-split. One model for the main table (substrate is the treatment);
  2–3 models appendix-only.
- **Grader** (`grade.ts`): attack-success and task-success classified from
  decision logs + transcript markers, never from model self-report.
- **Analysis** (`analyze.ts`): per-arm tables (success rates, precision/
  recall, cost frontiers, blast radii) from the bench JSONL.

## Results

Pending first runs. (Placeholders removed until real numbers exist — this
section stays empty rather than fiction-filled.)

## Threats to validity

- One operator's decline distribution shapes the mined policy (external
  validity); mitigated by seeding declines from multiple synthetic operator
  profiles.
- Free-tier endpoints drift (rate limits, models); every run prints
  receipts; analytics recorded per call.
- Grader depends on decision-log fidelity; the ledger makes the logs
  tamper-evident (RQ6), not correct — grader logic is unit-tested.

## Reproducibility

Apparatus in-repo (`src/bench/`), tasks as flat files, results as JSONL,
every bench run's decisions on the hash-chained audit log;
`codewhip audit --verify` proves the evaluation trail wasn't edited.
