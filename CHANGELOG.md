# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). Every run prints its receipts
(`tokens / model mix / $`) — cost behavior changes are called out explicitly.

## [Unreleased]

### Added

- `webfetch` tool: fetch a page for reading (docs, references, changelogs) as `text` (default, markup stripped) or `html`. https-only, 30s timeout, 1MB cap, secrets redacted before the model sees output; ask-by-default per host, memorable per https origin via `a` (`remembered.jsonl`), promotable to standing denies via `policy approve "webfetch:<origin>"`.
- Provider-call resilience: chat timeouts are typed `timeout` (120s builtin default, single `DEFAULT_CHAT_TIMEOUT_MS` — no per-provider constant farm) and join the `--models` rotation / `--failover` path instead of dying instantly; `--retry-wait` stays 429-only. New `--timeout-ms` run flag (5000..120000) overrides the per-call budget without re-registering the provider. Unarmed timeouts name the remedy.
- Per-command help (`codewhip help <command>`, `codewhip <command> --help`); first-run funnel routes `init` → `demo --deny` → `auth login`; dead-end errors name the next command.
- Builtin providers `bai` (B.AI gateway: `https://api.b.ai/v1`, `BAI_API_KEY`, credit billing via `https://chat.b.ai/chat`) and `fabryka` (router: `https://router.fabryka.ai/v1`, `FABRYKA_API_KEY`, default `qwen3.6-35b-a3b` reasoning model, $0.20/$0.60 per 1M tokens). Both cost-untracked in receipts; the B.AI default is a pricing-table pick tagged untested until a live probe clears it.

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
