# 02 — Memory: The Compounding Moat

> Specific knowledge can't be trained. It has to be earned, per repo, per team, per rejection.

CodeWhip `0.1.0` is a stub (`run` → "not implemented yet"). That is an advantage: we can instrument the learning loop from line one. OpenCode stores sessions in local SQLite (`opencode.db`, messages/parts/events) but never compounds them — sessions are reopenable, not recallable. Claude Code has memory/Dreaming/Outcomes-grader but it is closed and cloud-tied. Our moat is local-first state that compounds.

## 1. Signal taxonomy — what we collect, why it can't be copied

Collect only signals with outcome attached. Logs without verdicts are liabilities.

1. **Accept/reject diff outcomes (highest value).** Per hunk: accepted as-is / edited then accepted / reverted within 60 min / rejected outright. Plus: prompt hash, model id, files touched, test result after. *Why uncopyable:* Cursor proved this with real-time RL (Composer checkpoints every ~5h, +2.28% edit persistence, accept→persist 76%→81% in 2026). But Cursor's signal is cross-user IDE telemetry. Ours is per-repo, per-team, offline. GitHub can't scrape "why this team rejected this refactor."
2. **Terminal tool outcomes.** Command, cwd, exit code, duration, stdout-tail hash, follow-up fix. Distinguish flaky test vs. real breakage vs. lint-nit. *Why uncopyable:* generic agents log tool calls; almost none join them to the human verdict 10 minutes later. That join IS the moat.
3. **Team policy corpora.** Codified rejections: "never raw SQL in handlers," "all Money in cents," "no new deps without ADR." Stored as testable rules, not vibes. *Why uncopyable:* every team's scar tissue is different. Pre-training never sees it. Mem0/Zep/Letta store facts about users; we store judgments about code.

Explicit non-goals: raw transcripts, embeddings of everything, keystroke telemetry. Noise is not signal.

## 2. Memory v1 design — files-first, git-native

No vector DB. No graph DB. No server. For a solo builder, every new infra dependency is a second job.

```
.codewhip/
  memory.md        # <100 lines, hand-editable, injected every run
  notes/<path>.md  # per-file/dir lessons, e.g. notes/src_auth.md
  outcomes.jsonl   # append-only: one JSON line per proposal outcome
  policy.md        # team rules promoted from repeated outcomes
```

**Formats (fixed schema, no freeform sprawl):**

`memory.md`: `## Patterns (do) / ## Anti-patterns (don't) / ## Gotchas` — each bullet: `rule + 1-line evidence (date, outcome id)`. Hard cap 100 lines; oldest unreferenced bullet evicted monthly.

`notes/<path>.md`: max 20 lines per source file. Deleted when source file deleted.

`outcomes.jsonl`: `{ts, prompt_hash, model, files[], diff_hash, verdict: accepted|edited|reverted|rejected, tests: pass|fail, latency_ms, note}`. This is the training set we will never sell.

**Update rules:**
- Write happens post-verdict, never pre-generation. No speculative memory.
- Promotion threshold: 3 consistent rejections → candidate entry in `policy.md`; human approves with one command (`codewhip memory approve`).
- Contradictions resolved by recency + verdict strength (revert beats accept), not by LLM judge. Zep-style temporal validity (`valid_from`, `superseded_by`) implemented as two YAML fields, not a graph DB.
- Everything is diffable, greppable, `git log`-able. `memory.md` merges like code.

**Path to graph:** only when flat files provably fail — i.e. >500 outcomes and multi-hop queries ("which auth change broke billing?") recur weekly. Then build Graphiti-style edges *derived from* `outcomes.jsonl`, never replacing it. Mem0 is the fastest bolt-on, Zep wins on temporal queries, Letta wins when the agent owns its blocks — all three cost 120–500ms/turn and a hosted dependency. We pay zero until the pain is real.

## 3. Feedback loop — improvement without training a model

We do not fine-tune. We retrieve, rank, and refuse.

1. **Inject:** every `codewhip run` loads `memory.md` + relevant `notes/<path>.md` (by files in context) into system prompt. ~30 lines, ~400 tokens. Cheaper than any Mem0 `search()` call.
2. **Constrain:** `policy.md` entries compile to pre-flight checks (grep/AST/lint). Violation = generation blocked before tokens burned, with pointer to offending rule.
3. **Rank:** when 2+ candidate patches exist, score = `base_quality - 10 * past_revert_rate(same pattern, same dir)`. Past rejections literally downvote future diffs.
4. **Learn:** nightly `codewhip memory distill` scans last 50 outcomes, proposes ≤3 memory.md edits. Human accepts/rejects. Rejection itself is logged — the loop learns about the loop.

Cursor needs billions of tokens and a 5-hour RL pipeline. We need 50 JSON lines and judgment. Same shape, solo scale.

## 4. Switching-cost statement

Leave CodeWhip and you lose, on day one:

- 6 months of *your team's* accept/reject verdicts mapped to *your* codebase — irreproducible without re-living every bad diff.
- `policy.md`: the encoded scar tissue no new hire (human or agent) has.
- Per-file gotchas that prevent the exact outage you already paid for once.

Models are rented. Memory is owned. Anyone can download a better router tomorrow; nobody can download your memory.

## 5. Open disagreements

**To naval-leverage (loop/router-first):** you are building a faster horse for a race base models win by default. Smart routing, multi-model fallback, latency optimization — Cursor, Anthropic, and OpenAI ship that quarterly and erase you. Routing has zero switching cost: swap the router, keep the workflow. Memory has total switching cost: swap the tool, lose the knowledge. Build the loop second. The loop is leverage only *after* there is something worth leveraging — the accumulated verdicts. Otherwise you are optimizing the delivery of forgettable work.

**To naval-governor (governance-first):** governance without memory is theater. Static policy files nobody updates become `SECURITY.md` — revered, ignored. Your position assumes teams know their rules upfront; they don't. Rules are *discovered* through rejections. If governance ships before the outcome log, you will enforce guesses. My order is strict: outcomes → distilled memory → promoted policy → enforced check. Governance is the output of memory, not its prerequisite. Ship the verdict logger before the permission lattice.

**To naval-scout (GTM-first):** GTM without retention is a leaky bucket with good marketing. Terminal-first CLI distribution is correct as wedge, but if the first 100 users leave nothing behind that makes user 101's experience better, you have no flywheel — you have a download counter. Cursor didn't win on landing page; it won because user N's rejection improved user N+1's suggestion (real-time RL, cross-user learning). Our equivalent at solo scale: per-repo memory that visibly prevents repeat mistakes within week one. If scout optimizes stars and installs before `outcomes.jsonl` exists, we will churn every curious dev who tries us once and forgets us. Retention compounds; attention doesn't.
