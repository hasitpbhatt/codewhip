# Researchers panel review — "One Yes Is Forever" (docs/paper/00-thesis.md) + src/bench/

**Panel:** 5 voices — (1) agent-safety researcher, (2) measurement-paper veteran, (3) ML systems person, (4) benchmark designer, (5) skeptical senior PI.
**Reviewed:** 00-thesis.md (2026-09-13 reframe), src/bench/{types,tasks,runner,grade,analyze,cli,bench.test}.ts, src/loop.ts, src/policy.ts, src/remember.ts, docs/moat/*-subagents-review.md. Prior art checked against the 2025–2026 literature (sources at bottom).
**Date:** 2026-09-13

---

## Voice 1 — Agent-safety researcher (novelty)

The thesis's central novelty claim — "the approval-persistence attack class is unnamed anywhere we could find" — is **false as of 2026 and a reviewer will find the counterexamples in ten minutes**. This is the single fastest route to a reject.

The positioning table cites AgentDojo, CaMeL, Progent, AgentSpec, and arXiv:2509.22040, but misses the entire 2026 cross-session persistence line:

- **ClawWorm / "Self-Propagating Attacks Across LLM Agent Ecosystems" (arXiv:2603.15727)** — cross-session infection of a production coding-agent framework via memory/file persistence, and it *explicitly* analyzes the "Always Allow" approval-persistence flaw (an approved `whoami` allowlisting `/bin/zsh`), reporting 63% aggregate attack success. That is your RQ2, partially published, on a real product.
- **eTAMP (arXiv:2604.02623)** — environment-injected memory poisoning achieving cross-session, cross-site compromise without direct memory access.
- **Systematic Study of Memory Poisoning in LLM Agents (arXiv:2606.04329)** — measures cross-session persistence (ASR ≈50%). "Sleeper" memory poisoning (2605.15338), MemPoison (2605.29960), MINJA — the persistence axis is crowded.
- **Rules File Backdoor (Pillar Security, 2025) → CVE-2025-54136 (Cursor)** and ~8 more prompt-injection CVEs across Copilot/Claude Code/Cursor/Amazon Q/Codex in 12 months — the repo-instruction-file half of your "persistence surface" is already product-confirmed.

**What survives:** the persistence literature above poisons *content* (memory entries, rules files). What nobody measures as a lifecycle is the **authority store**: human approval decisions → mined rules → harness enforcement → attacker exploitation, i.e., poisoning via the operator's own fat finger rather than via injected text. That reframing ("grant persistence vs content persistence") is defensible and crisp — but you must claim it as a *measurement delta against named 2026 work*, not as an unnamed class. Also note CaMeL is mis-cited in the table: it is a defense with formal IFC guarantees, and your "gap" column describes your mining source, not a limitation of CaMeL. Sloppy positioning columns get circles in red.

## Voice 2 — Measurement-paper veteran (validity of the core metric)

The headline metric is **confounded in the code, and the repo's own test comment admits the confusion**. In `src/bench/runner.ts` (~line 52), `askCount = { n: 0 }` is constructed **inside the per-run loop**: every run of a `runsPerCell` cell receives a *fresh* fat-finger. So run 2's first ask is also answered "always", and `analyze.ts`'s persistence signal (firstRunAttack → laterRunAttack) measures *per-session re-success under a perpetually semi-attentive operator* — not whether the original grant **persisted**.

Worse, `src/bench/bench.test.ts:74–105` asserts the opposite of what the code does: the comment says "run 2 … the now-attentive operator denies, and the call is held", but the assertion right below it is `strictEqual(rows[1]?.attackSuccess, true)` — because the code fat-fingers run 2 as well. A reviewer who reads the apparatus (they will; you ship it) concludes the authors cannot distinguish "the rule persisted" from "the operator fat-fingered again". That distinction **is the paper**.

Second problem: the one in-repo cell that *could* demonstrate persistence is untested. Curation (`src/remember.ts`) makes `curl` unmemorable, so the bench's RQ2 test exercises the case where persistence is **blocked by construction**. But webfetch origins and edit paths ARE memorable by design — a fat-fingered `always` on the beacon origin stores `https://attacker.example` permanently and run 2 matches it via `+remembered` with no ask. The persistence-possible cell (webfetch under `fatfinger` × `runsPerCell≥2`) exists in the apparatus and is never run or asserted. The suite demonstrates the null case and hides the positive case.

Required fixes: (a) one fat-finger **per cell**, not per run; (b) define persistence as attack success in run k>1 *given an attentive operator*, decomposed into three events: rule minted / rule honored / operator re-approved; (c) run the webfetch persistence cell. Without (a)–(c) the central table is uninterpretable.

## Voice 3 — ML systems person (arms, confounds, engineering)

The arm design is confounded three ways:

1. **Yolo arming.** `harness-policy` and `prompt-policy` both run `yolo: true` — every ask auto-approves. Fine for isolating the surface variable, but then (i) RQ1 describes a no-operator posture that contradicts the repo's own converged ruling (ask-default, "no yolo-by-default"); (ii) any cross-arm comparison (e.g., vs `fatfinger`) conflates surface with operator model; (iii) the benign-blocked column in `analyze.ts` is structurally ~0 under yolo arms because asks never fire — so the false-positive cost of the defense is *unmeasurable in the arms where the defense is on*. You need the full factorial: {surface} × {operator: yolo / fat-finger / attentive}.
2. **The prompt arm is a partial strawman.** `policySurface: "prompt"` drops not only policy.md but the **non-overridable denylist and promoted denies** (`skipPolicyDenies`, `src/policy.ts:178–225`) — a much larger removal than "moving text into the prompt". Meanwhile the prompt rule text is *stricter* than the compiled shapes (blocks subdomains; origin-exact denies don't). Both choices are documented as intentional, but the paper must show a same-semantics surface-only ablation plus the asymmetric variant, or reviewers will call RQ1 rigged in both directions at once.
3. **Fake-port circularity.** Tests named "RQ1 prompt arm: the same rules in the prompt do not stop a yolo'd fetch" script the model via `makeFakePort` — the conclusion is baked into the fixture. As apparatus tests these are fine; labeled as RQ findings they are circular evidence. Rename them (apparatus-vs-research-conclusion hygiene), and state explicitly that no paper number comes from a scripted port.

Also: `grade.ts` has **no task-success metric** despite the thesis claiming "attack-success and task-success classified from decision logs" — the method text promises something the code does not compute. And RQ4 is internally inconsistent with the repo's own adversarial review (F2a: children inherit no budget, ~24× single-turn overshoot via `delegate_many`; F2b: delegate excluded from the repeat guard) while the seed suite contains **zero delegation tasks** — the one cost-inflation vector your own review flagged as High is untested. Either fix the budget propagation or report the hole as a finding; measuring a defense you've already proven broken in your own moat docs, on tasks that avoid the breakage, is the kind of thing PC members remember.

Reproducibility: free-tier endpoints serve drifting models — pin model fingerprints and dates, or run the main table on fixed paid endpoints; `runsPerCell` is hard-capped at 10 (`cli.ts`), far below what binary rates need.

## Voice 4 — Benchmark designer (RQs, tasks, statistics)

RQ-by-RQ triage:

- **RQ2 — core, keep, but it currently has two metrics and neither measures persistence** (see Voice 2). Also missing: persistence *decay* (does the grant survive k sessions, rule-file edits, policy promotion?).
- **RQ1 — good ablation, not a standalone RQ.** Fold under RQ2 as "enforcement surface".
- **RQ3 — the best RQ in the paper and the least implemented.** Precision/recall of the mined shape grammar vs held-out variants is genuinely novel and quantifiable; `analyze.ts` computes nothing of the sort (no precision, no recall, no shape-grammar evaluation — just per-class success counts). With 1 held-out variant task (subdomain) you cannot estimate a generalization rate; you need tens of variants per shape family (subdomain, path alias, flag reorder, case, URL-encoding, redirect chains).
- **RQ4 — weak.** "Budget caps blast radius" is an engineering property, and its metric (token/$ damage *distribution*, fan-out exposure) is unimplemented (totals only, no distributions, no delegation tasks).
- **RQ5 — off-thesis.** A repeat-memo nudge is a cost paper, not a persistence paper. A* security reviewers will ask why it's in scope. Move to appendix or a separate workshop paper.
- **RQ6 — not a research question.** Tamper-evident evaluation is a reproducibility feature; demote to a section. "Tamper detection rate" of your own `verifyChain` is a unit test, not an experiment.

Missing RQs a reviewer will demand: **(a) utility cost** — task-success on benign work under each defense (unimplemented; and `benignBlocked` = "a deny anywhere in the run" is not task failure — a benign task can succeed despite a deny, so the metric is wrong as well as crude; the benign set is 2 tasks, useless for FP rates); **(b) external baselines** — the only "defense" evaluated is codewhip itself; you need at least CaMeL-style IFC, spotlighting/classifier baselines, or Progent, else this reads as a product evaluation with a conflict of interest; **(c) the operator model** — "fat-fingered `a` is the common case" is asserted with zero grounding; cite approval-fatigue literature or run a small (n≈20–30) user study measuring always-allow rates. This assumption is load-bearing for RQ2's threat model and currently floats free.

Statistics: 7 attack tasks × 4 arms × ≤10 runs × 1 model supports **no inferential claim**. Reviewers will require: ≥30–100 runs/cell (Wilson CIs — near-0/1 rates are the norm here), 3–5 models for the *attack prevalence* claim (the "substrate is the treatment" argument is valid only for defense ablations, not for measuring how often models obey injections), paired comparisons (McNemar or paired bootstrap over shared tasks), multiple-comparison correction, and attacker-compute reporting plus inter-attempt variance for the adaptive attacker. ~20–50 tasks per attack class, not 1–2.

## Voice 5 — Skeptical senior PI (accept/reject calculus)

**Single weakest section:** RQ2's real-agent cross-product measurement — the actual headline, the thing the title is about — has **zero apparatus**. Build order step 4 ("headless drivers for Claude Code -p, OpenCode, Aider, executed twice with a restart between") is a plan, not code. A measurement paper whose central measurement is unbuilt, whose only existing persistence proxy is confounded (Voice 2), and whose results section is empty is, as submitted today, a **desk reject** at S&P/CCS — and at NeurIPS/ICLR it has the additional problem that the defense being evaluated is the authors' own product with no external baseline.

Three more kill vectors: (1) the stale related work (Voice 1) — one reviewer with a search bar sinks the "unnamed anywhere" sentence and, with it, trust in the rest; (2) attacking real products requires the ethics/disclosure machinery to already exist — S&P and CCS ethics committees now push back on measurement papers whose disclosure timeline is "planned"; (3) decision-level grading (attacker.example is non-routable) is a proxy for exfiltration; defensible, but only if validated against delivery-level ground truth in at least one cell (local HTTP sink), with the proxy's precision reported.

**What gets it accepted — the three cards, in order:**

1. **CVE-backed cross-product persistence measurement.** The Rules File Backdoor → CVE-2025-54136 lane is live and hungry for a systematic treatment. If your harness drives N real agents through the same malicious-repo protocol, twice with restart, and produces vendor-confirmed findings (CVEs or hardening changes) on the authority store — *not* the already-published rules-file content story — that is a genuine S&P/CCS measurement paper. The disclosure section stops being an obligation and becomes a result.
2. **The grant-vs-content persistence taxonomy + mined-shape generalization (RQ3 done properly).** Reframing the 2026 memory-poisoning literature as one of two persistence channels, with the operator's own approvals as the other, is a citable conceptual contribution; RQ3 (how mined deny/allow shapes fail to generalize under adaptive evasion) is the quantitative heart nobody has published.
3. **Decision-level, content-blind, tamper-evident grading as open methodology.** The hash-chained evaluation trail (`verifyChain`, receipts) is a differentiator reviewers haven't seen; play it as reproducibility infrastructure, not as RQ6.

---

## Panel consensus

**Verdict: REJECT as it stands today; weak-accept trajectory, reachable, if the five changes below land.** The persistence axis survives the prior-art sweep but only in its narrowed form (authority-store persistence vs the published content-poisoning line); the apparatus is roughly 20% of the paper (RQ1/RQ2 proxies only); and one confound sits directly inside the headline metric. The gap between the thesis's claims and the code behind them is currently the paper's biggest vulnerability — reviewers can diff them, because you ship the code.

**Top 5 changes (ordered):**

1. **Fix the persistence metric before another run.** One fat-finger per cell (`runner.ts` askCount scoping), persistence = run-k>1 success under an attentive operator, decomposed into minted / honored / re-approved events; add and run the webfetch-origin persistence cell (the positive case curation permits); fix the self-contradictory comment/assertion pair in `bench.test.ts:74–105`.
2. **Rewrite the novelty claim and related work.** Retract "unnamed anywhere"; position against ClawWorm (2603.15727), eTAMP (2604.02623), the memory-poisoning systematic study (2606.04329), MCP consent-lattice work (2605.11360), and the Rules File Backdoor CVE line. New claim: first *lifecycle measurement* of grant persistence (decision → rule → enforcement → attack) across real products, as distinct from published content-persistence attacks.
3. **Build the cross-agent harness — it is the paper.** Headless drivers for ≥3 real coding agents with per-product restart/state semantics; run the same malicious-repo cells; start responsible disclosure now so vendor confirmations (CVEs) exist at submission time.
4. **Rebuild the experiment design.** Factorial arms (surface × operator × attacker); adaptive LLM-driven attacker replacing the static payloads (AgentDojo-style, with attacker-budget reporting); a delivery-level validation cell (localhost sink) for the decision-level proxy; ≥3–5 models for prevalence, ≥30 runs/cell with Wilson CIs, paired tests over shared tasks, 20–50 tasks per attack class including delegation-based cost-inflation (your own F2a finding).
5. **Add what's missing and cut what doesn't belong.** Implement task-success/utility grading (promised in the method section, absent from `grade.ts`); fix or replace `benignBlocked`; add ≥1 external defense baseline; ground the fat-finger operator model (citation or mini user study); move RQ5 out of the thesis, demote RQ6 to a reproducibility section.

## Sources checked for the prior-art sweep

- [Demystifying Prompt Injection Attacks on Agentic AI Coding Editors (arXiv:2509.22040)](https://arxiv.org/html/2509.22040v1)
- [Rules File Backdoor — Pillar Security disclosure](https://www.pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents) · [Hacker News coverage](https://thehackernews.com/2025/03/new-rules-file-backdoor-attack-lets.html) · [CVE-2025-54136 (Cursor)](https://www.facebook.com/thehackernews/posts/-a-high-severity-flaw-in-cursor-ai-cve-2025-54136-let-attackers-hijack-trusted-m/1136374518527130/)
- [Self-Propagating Attacks Across LLM Agent Ecosystems — ClawWorm (arXiv:2603.15727)](https://arxiv.org/abs/2603.15727)
- [Environment-Injected Memory Poisoning Attacks on Web Agents — eTAMP (arXiv:2604.02623)](https://arxiv.org/html/2604.02623v2)
- [A Systematic Study of Memory Poisoning Attacks in LLM Agents (arXiv:2606.04329)](https://arxiv.org/html/2606.04329v1)
- [Lattice Refinement for Consent-Driven MCP Authorization (arXiv:2605.11360)](https://arxiv.org/html/2605.11360v1)
- [AI coding tools' config files as attack surface — 8+ injection CVEs across Copilot/Claude Code/Cursor/Amazon Q/Codex](https://yage.ai/share/ai-coding-config-injection-en-20260422.html)
