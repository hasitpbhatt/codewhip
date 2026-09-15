# 08 — Provider Memory Flywheel: Stats, Failures, Custom Providers

> The router is commodity. The reliability map you earn per team per network is not.

CodeWhip already records every chat/models call with `src/provider-stats.ts` → `provider-analytics.jsonl` in the global config dir. That is the seed. We now compound it into per-team, per-repo routing intelligence that no competitor can copy without living the failures.

## 1. Signal taxonomy — what we collect, why it can't be copied

1. **Provider call outcomes (global, append-only).**
   `ts, provider, model, kind, outcome[ok|auth|quota|timeout|network|bad_model|other], status, host, ms, error_hash`.  
   Why uncopyable: success rate is a function of *your* key, *your* network, *your* IP reputation, *your* custom endpoint. Cloud providers see their own infra; they never see your `ollama-local` failing every 90s under load, or `tokenharbor` 429’ing only for your org at 9am UTC. The map is personal.

2. **Failure fingerprints with repo context.**
   Join provider call with `outcomes.jsonl` runId: `provider,model,task_class,private?, cwd_hash, failure_bucket`. Distinguish `bad_model` for a retired id vs `auth` after key rotation vs `timeout` for a local runtime under memory pressure.  
   Why uncopyable: OpenCode logs sessions; Claude Code logs internally. Neither exposes a human-verdict-joined failure graph per repo. The join *is* the signal.

3. **Custom provider lifecycle.**
   Registration metadata (`id, baseUrl, defaultModel, envVar, timeoutMs, rateLimitedHint`) + health history + model catalog drift detection (`models` call returns diff). Detect model retirement, path change, latency regression.  
   Why uncopyable: the set of custom endpoints a team registers is private infrastructure. Your `my-gateway` reliability is yours alone. Competitors can list public providers; they cannot copy your private routing table.

4. **Routing decisions and human overrides.**
   `router_class, chosen_provider, override_used?, final_cost, verdict`. Captures when the classifier was wrong and the user forced `--provider`.  
   Why uncopyable: reveals the team's actual risk tolerance for private prompts, cost sensitivity, and which models they trust for polish vs implement. This is scar tissue.

Explicit non-goals: raw request bodies, provider keys, prompt text. We record outcome buckets, not content.

## 2. Memory v1 design — files-first, two-tier

**Global tier — user config dir, never repo.**
```
~/.config/codewhip/
  provider-analytics.jsonl   # append-only, per-call record
  custom-providers.json      # registration, no secrets
```
`provider-analytics.jsonl` already exists. Keep it append-only, best-effort write. No DB. Aggregation is pure: `summarizeCalls()` → `ProviderHealthSummary`.

**Repo tier — `.codewhip/`, git-native, compounds.**
```
.codewhip/
  provider-policy.md      # human-approved routing rules, e.g. "avoid X:model for private"
  provider-memory.md      # auto-distilled notes: "<provider>: success 73% last 30d, failures spike 09:00 UTC"
  provider-decisions.jsonl # {ts,runId,task_class,chosen,reason,override,verdict}
```
Formats fixed:
- `provider-policy.md`: markdown, max 100 lines, sections `## Avoid`, `## Prefer`, `## Local-only`. Each line: `provider:model  reason  evidence(runId)`. Human edit only.
- `provider-memory.md`: auto-generated, 30-line cap, injected into router classifier as context (~300 tokens). No prompt rules.
- `provider-decisions.jsonl`: one line per run, links provider choice to outcome. Used for nightly distill.

Update rules:
- Write post-run, never pre-generation.
- Promotion threshold: 7 failures of same `provider:model:outcome` in 14 days → candidate entry in `provider-policy.md` via `codewhip provider candidates`.
- Human approval required for `Avoid`/`Prefer`. Auto-memory can be auto-written; policy changes are audited.
- Contradictions resolved by recency + failure cost (auth > quota > timeout).
- All files are diffable, greppable, gitignored where secrets could leak.

Path to graph: only if >1000 provider calls + multi-hop queries like "which custom provider broke most after deploy?" recur weekly. Then derive edges from `provider-decisions.jsonl`, never replace flat files.

## 3. Feedback loop — outcome → improvement, concretely

1. **Record.** Every chat/models call → `recordProviderCall`. Every run → append `provider-decisions.jsonl` with router reason and final verdict.
2. **Aggregate.** `codewhip provider stats` reads `provider-analytics.jsonl`, renders per-model successRate, last failure, errorKinds. Warns below 80%.
3. **Constrain.** Router loads `provider-policy.md` before classification. `Avoid` entries are pre-flight denies for that task class; `Local-only` forces loopback for private prompts.
4. **Rank.** Scoring for candidate models: `base_score - 20 * recent_failure_rate(provider:model, last 7d) - 5 * avg_latency_p95`. Failures literally downvote future routing.
5. **Learn.** Nightly `codewhip provider distill` scans last 100 decisions + analytics, proposes ≤3 updates to `provider-memory.md` and ≤1 policy candidate. Human accepts/rejects. Rejection logged.
6. **Custom provider health.** On `models` call, compare catalog hash vs last seen. If default model missing → `bad_model` alert + suggest alternatives from same provider. Timeout regression >2× median → flag for manual timeout tune.

No model training. Retrieval + ranking + pre-flight deny. Same shape as memory flywheel, different domain.

## 4. Switching-cost statement

Leave CodeWhip and you lose:

- Your personal provider reliability map: success rates for every public and custom endpoint from *your* network, *your* keys, *your* usage windows. Rebuilding requires re-experiencing every auth expiry, quota hit, and local runtime OOM.
- Custom provider registry with validated base URLs, timeouts, and rate-limit hints tuned to your infra. Migration means re-validating each endpoint manually.
- Repo-specific routing policy: which providers are banned for private prompts, which models you distrust for polish, which overrides you made after a failure. That is operational knowledge, not config.

Providers are interchangeable. The health map you earned is not.

## 5. Open disagreements

**To naval-leverage:** Router breadth and latency optimization feel like moat but are commodity. You can swap the classifier tomorrow; you cannot swap a 6-month failure map tied to your keys and network. Provider memory compounds; routing tables don't. Build the stats → policy loop before adding a 10th provider.

**To naval-governor:** Governance without provider context is blind. Denying shell is static; denying a flaky custom provider for private tasks is dynamic and evidence-based. Provider memory is the first governance rule that *learns*. Audit every `provider-policy.md` mutation via `audit.log` with `prev_hash`. Memory without provenance is liability — which is why `provider-decisions.jsonl` is hash-anchored to runs.

**To naval-scout:** Distribution wins users, but provider memory wins retention. A new user gets instant value from `provider stats`, but after 30 days the warnings are *yours* — "your `ollama-local` times out on big diffs, switch timeout to 90s". That's a demo you cannot fake on day one and a reason to stay on day thirty. Ship stats visibility in H1, policy promotion in H1, and let the flywheel do GTM.

## 6. Implementation notes

- Keep `provider-analytics.jsonl` global; do not copy to repo. Repo files reference providers by id only.
- `codewhip provider stats [--since 7d]` renders health; `codewhip provider candidates` lists auto-detected Avoid/Prefer.
- `codewhip provider distill` = read-only proposal; `codewhip provider approve "<rule>"` writes to `provider-policy.md` and emits audit entry.
- Custom provider add validates loopback/http rules as-is; health monitoring extends validation to periodic `models` probe.
- Receipts already print `tokens / model mix / $`. Add `provider health` summary to `metrics` output once 100+ calls exist.

This is the data flywheel that makes CodeWhip stickier than OpenCode's sessions and less leaky than Claude Code's cloud memory: local-first, per-team provider intelligence that compounds with every failure you never have to repeat.
