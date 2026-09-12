# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). Every run prints its receipts
(`tokens / model mix / $`) — cost behavior changes are called out explicitly.

## [Unreleased]

### Added

- **Transcript compaction** (committee ruling 3): long runs survive their own context window. When a single provider call's estimated size (chars/4, labelled "est." — no tokenizer dep) crosses the ceiling, the oldest tail is pruned in two tiers: old tool outputs are truncated to a 600-char head with a visible `…[compacted]` marker, then whole old exchanges are elided to stubs naming the tools called (assistant + tool responses move as a block, so no orphan tool messages). System prompt, original task, and the newest exchanges are never touched. On by default (est. 60k-token ceiling), `compactTokens: 0` disables; every compaction prints an honest receipt line and lands in the run summary (`compacted: N old tool output(s) truncated, M exchange(s) elided …`).
- **Plan mode** (`--plan` run flag): run-scoped read-only policy — `edit`/`write`/`bash` are refused by the harness before the permission ladder for the whole run, so `ask`, `--yolo`, and remembered rules can never grant them (committee ruling 2). Read/search/webfetch stay allowed; the system prompt gains a PLAN MODE preamble making the run's final answer the implementation plan. Every refusal is recorded as `deny:plan:read-only` on the hash-chained audit trail; the banner announces the mode up front.
- **Undo** (`codewhip rollback`): every `edit`/`write` a run executes is snapshotted first (before-image + sha256 manifest under `.codewhip/checkpoints/<runId>/`, JSONL, self-protecting — harness state is never checkpointed). `codewhip rollback <runId-prefix>` verifies every image against its manifest before touching anything, then restores newest-to-oldest (files the run created are removed); `--list` shows checkpointed runs. Restores land on the hash-chained audit trail (`tool: rollback, actor: human`). Runs print `checkpoints: N file(s) snapshotted — undo: codewhip rollback <prefix>` when files were touched.
- `webfetch` tool: fetch a page for reading (docs, references, changelogs) as `text` (default, markup stripped) or `html`. https-only, 30s timeout, 1MB cap, secrets redacted before the model sees output; ask-by-default per host, memorable per https origin via `a` (`remembered.jsonl`), promotable to standing denies via `policy approve "webfetch:<origin>"`.
- **Streaming + slow-endpoint resilience**: chat calls now send `stream: true` and parse SSE, so first output arrives without waiting for the whole completion. The per-call budget (`--timeout-ms`, default 120s) bounds time-to-first-byte; once bytes flow, a 45s idle watchdog (never exceeding the caller's budget) takes over, so a slow-but-alive model is not killed by a total wall clock. A gateway that rejects a streaming body (400/422) or opens a stream that carries nothing gets one automatic non-streaming retry, and that provider stops streaming for the rest of the run. `--no-stream` forces whole-body responses. Receipts print `est.` when a stream ends without a usage block instead of presenting a chars/4 estimate as a meter reading.
- **Timeout classification fix**: `--timeout-ms`/provider timeouts were aborted with a custom reason, which makes `fetch` reject with that reason object (`name: "Error"`) — so the adapter's name-sniffing read every real timeout as a generic network failure, typed non-retryable. Timers now carry an explicit `timedOut`/`stalled` flag (the same idiom as the loop's `withTimeout`), so timeouts are typed `timeout` and recorded as `timeout` in provider analytics, joining the `--models` rotation / `--failover` / `--free` path and printing the remedy hint instead of dying instantly.
- `--timeout-ms` ceiling raised from 120000 to 600000 (floor unchanged at 5000, default still 120s): the old maximum equalled the default, so a slow free endpoint (60–100s calls are routine) could not be given headroom without re-registering the provider. Bounds now live in one place (`MIN_CHAT_TIMEOUT_MS`/`MAX_CHAT_TIMEOUT_MS`).
- **Repeat-call guard**: identical `read`/`search`/`webfetch` calls within a run are served from an in-run memo instead of re-executing and re-appending the same output to a transcript that every later turn re-sends; a successful `edit`/`write` clears the memo so a legitimate re-read still runs. Repeats stay on the audit trail as `allow:loop:repeat-call`, and after three identical repeats the result is replaced by a nudge to act on what it already has. Denials are never memoized (an `a` answer can promote a shape mid-run). The run summary prints the count.
- Provider-call resilience: chat timeouts are typed `timeout` (120s builtin default, single `DEFAULT_CHAT_TIMEOUT_MS` — no per-provider constant farm) and join the `--models` rotation / `--failover` path instead of dying instantly; `--retry-wait` stays 429-only. New `--timeout-ms` run flag (5000..600000) overrides the per-call budget without re-registering the provider. Unarmed timeouts name the remedy.
- Per-command help (`codewhip help <command>`, `codewhip <command> --help`); first-run funnel routes `init` → `demo --deny` → `auth login`; dead-end errors name the next command.
- Builtin providers `bai` (B.AI gateway: `https://api.b.ai/v1`, `BAI_API_KEY`, credit billing via `https://chat.b.ai/chat`) and `fabryka` (router: `https://router.fabryka.ai/v1`, `FABRYKA_API_KEY`, default `qwen3.6-35b-a3b` reasoning model, $0.20/$0.60 per 1M tokens). Both cost-untracked in receipts; the B.AI default is a pricing-table pick tagged untested until a live probe clears it.
- 8 builtin free aggregators (endpoints live-verified 2026-09-11), 4 of them keyless: `kilo` (`:free` models fully anonymous — chat works with no Authorization header; paid models 401), `opencode` (Zen free tier rides the anonymous `public` bearer plus per-provider static headers — new optional `ProviderConfig.headers` merged into every call — presence-checked `x-opencode-session`), `empero` (`free.empero.org`, openly free with a `free` placeholder key; was in maintenance at the probe), and `llm7` (existing). Free-key tiers: `groq`, `cerebras`, `openrouter`, `gemini`, `zai` (env vars `GROQ_API_KEY`/`CEREBRAS_API_KEY`/`OPENROUTER_API_KEY`/`GEMINI_API_KEY`/`ZAI_API_KEY`). All free-tier defaults are priced $0 in receipts, never fiction-priced.
- `codewhip free` command: read-only listing of the free-provider chain (keyless rows first, free offer, limits, key consoles; no key, no network).
- `--free` run flag: arms the ordered free-only chain on a run — head = explicit `--provider` (free-catalog ids only) or the first free candidate with a usable key, hops in catalog order (keyless tiers first, llm7 as the keyless floor) on rate-limit/timeout, each provider once per run; never bills pay-go. Mutually exclusive with `--failover` (`use --free or --failover, not both`).
- Failover generalized from a single switch to an ordered chain (`agentLoop` `failovers?: FailoverTarget[]`): targets are consumed in order, each at most once per run, and same-provider `--models` rotation stays head-provider-only. The `outcomes.jsonl` `failovers[]` record shape is unchanged (`from/to/reason/waitedMs/step`).

## [0.1.0] — 2026-09-11

H1 agent loop live: `codewhip run` executes a real policy-checked, metered,
replayable loop. Costs: nvidia free tier = $0; other providers print
"cost untracked" pointing at their console.

### Added

- `agentLoop()`: stream → permission check → exec → append → repeat;
  Ctrl-C safe, `--max-steps 25` hard stop, `--token-budget` enforced mid-run.
- Five tools (`read`, `search`, `write`, `edit`, `bash`); git rides the bash
  allowlist. Output capped at transcript push so one runaway can't flood
  context.
- Harness-side policy: non-overridable denylist + shell-chaining deny;
  read-allow / edit-write-shell-ask defaults; `--yolo` bypasses ask, never
  the denylist; CI ask⇒deny.
- Hash-chained, ed25519-signed audit log (`audit --verify/--last/--replay/
  --export`); hashes-only at write, redaction holds by construction.
- Outcomes sidecar (`outcomes.jsonl`), curated "always allow" memory
  (`.codewhip/remembered.jsonl` with provenance), decline→candidate→promoted
  `policy.md` denies.
- Redacted `run --share` bundles anchored to the audit chain (local-file v1).
- 3-class router (implement / polish / private) with <$0.05 polish gate,
  6 builtin providers + custom OpenAI-compatible registration
  (`provider add/list/show/remove`), `--models` rotation, opt-in
  `--retry-wait` / `--failover` on 429 only.
- `init` / `auth` / `models` / `audit` / `metrics` / `verdict` / `policy` /
  `pack` / offline `demo --deny` ($0, no key needed).
- $0-quota test suite (168 tests) pinning policy, jail, memory, audit chain,
  redaction, router, metrics, promotion, packs, and loop.
- GitHub Action (`actions/run`) + starter pack + CI on Node 18/20.
