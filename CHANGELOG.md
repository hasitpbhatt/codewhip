# Changelog

All notable changes to this project are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/). Every run prints its receipts
(`tokens / model mix / $`) — cost behavior changes are called out explicitly.

## [Unreleased]

Cost behavior: new builtins are unpriced (`cost untracked`, console
pointer) except where noted; the free chain is unchanged (43 hops).

### Added

- **38 providers (96 → 134 builtins)** — OmniRoute registry + the
  awesome-freellm/awesome-free-llm-apis/cool-ai-stuff readmes, deduped
  against existing rows: first-party labs and clouds (openai, perplexity,
  writer, lambda, featherless, metallama, yi, baichuan, internlm, iflytek,
  reka, sarvam, typhoon, plamo, liquid, inception, nous, byteplus, xiaomi,
  arcee) and keyed aggregators/GPU clouds (heroku, modal, baseten,
  predibase, monsterapi, wandb, aimlapi, bytez, synthetic, nanogpt, kie,
  morph, galadriel, v0, factory, poe) — plus user-sourced `wrouter`
  (AccelsRouter, trial credit) and `arouter` (ARouter keyed gateway),
  endpoints verified against their own docs. Reachable via `--provider`;
  none joins `--free` (quotas unverified — trial credit is not free). Left out
  deliberately: same-backend dupes, oauth/cookie/IDE/web-scraper entries,
  non-bearer auths, image/audio-only and SDK-only providers, and relays
  with no verifiable default model.
- **`run --auto-failover`** — the $0-only chain with a quiet terminal:
  backend hops are recorded in the outcome/audit (receipt still splits per
  model) but not printed; total exhaustion still reports what was tried.
  Private runs stay head-only (consent covers one target). Not with
  `--free`/`--failover`.
- **Silent serve retry on `auto`** — a fully-auto request hops to the next
  healthy target on rate-limit/timeout/5xx (≤3 upstream attempts, each
  failure server-logged, winner named in `serviced_by`). Pinned
  `provider:model` requests never hop.

### Fixed

- **Test suite 133s → ~20s** — `background.test.ts` started an immortal
  `ping` and never stopped it, pinning the runner until the 120s default
  timeout killed the child. Tests now stop what they start, with an
  `after()` backstop for leftovers.

## [0.3.0] — 2026-09-18

Competitive-reality pass (analysis in `docs/moat/10-competitive-reality.md`):
the gap list a side-by-side with Claude Code produced, with the highest-value
items fixed the same day. Cost behavior: unchanged — receipts keep their
shape; eval adds a machine-graded measurement layer.

### Added

- **`codewhip eval`** — the task-success bars (≥70% polish / ≥50% implement)
  were demanded by the metrics table but never measured; now they are. 12
  fixture tasks ship in `tasks/` (4 polish / 8 implement), each a tiny repo
  with a checker script validated to fail on the broken fixture and pass on
  the solved one. The runner copies each fixture to a disposable temp dir,
  runs the real loop headless there (yolo armed — the dir is the sandbox,
  the denylist still applies), grades with the checker, merges the run's
  outcome row into the host `outcomes.jsonl`, and appends
  `.codewhip/eval.jsonl` (latest run per task wins). `codewhip metrics`
  reports the per-class bars (MET/NOT MET). Exit 0 only when everything
  selected passes (CI-usable). Flags: `--task`, `--provider/--model/--free`,
  `--max-steps`, `--token-budget`, `--timeout-sec`, `--tasks`, `--keep`.
- **`codewhip verdict --auto <prefix>`** — verdicts are the claimed
  compounding moat, but they were only written by manual CLI call; a
  compounding asset nobody feeds does not compound. `--auto` proposes
  accepted/edited/reverted from the run's checkpoint manifests vs the tree
  as it stands (git `status --porcelain` cross-check flags unexplained dirt
  and drops confidence), prints the evidence, and records on one keypress
  (explicit verdict override welcome). The judgment stays human-attached;
  the remembering is done for them. Non-interactive sessions refuse and
  point at the explicit form.
- **Live `/model` in the TUI** — `agentLoop` accepts `takePendingSwitch`, a
  per-turn hook: `/model <provider>[:<model>]` validates the target, builds
  the port, and the loop swaps it at the next turn boundary; receipts
  bucket usage per model, so the switch is visible in the mix. `/free`
  prints in-run free-chain visibility (usable/total hops, keyless count).
  `/plan` states honestly that plan mode is run-scoped (rerun with
  `--plan`) instead of silently noting a no-op.
- **System prompt steering** — grew from 22 lines with what the tool specs
  cannot carry: workspace/jail context, git conventions (`git status`/
  `git diff` before claiming tree state; never commit/push unasked),
  `delegate`/`delegate_many` guidance for read-heavy exploration, and an
  answer shape (lead with outcome, then evidence). Still deliberately
  token-efficient — it is re-sent every turn.
- **Builtin provider `codiv`** (api.codiv.ai): first-party OpenAI-compatible
  inference host — native `/v1/chat/completions` with standard Bearer auth,
  the standard `choices`/`usage` envelope, SSE with usage on the final chunk,
  and function `tools`/`tool_choice`, so it rides the shared adapter as a pure
  registry row (no new adapter code). Default model `diffusiongemma-26b`: a
  diffusion LM denoises output in 64-token blocks, so completions take seconds
  (the 120s default holds) and the server ignores sampling params codewhip
  never sends. Free experiment tier — no card, 10M text-generation tokens per
  account, 600 req/min — priced $0 on receipts (the provider's own sticker; an
  exhausted grant answers 429 `insufficient_quota` rather than a bill). Out of
  the free chain like the one-time grants (renewability unconfirmed); reach it
  with `--provider codiv`, key at `CODIV_API_KEY` (signup:
  https://codiv.ai/signup). `codewhip serve` fronts the whole registry, so
  codiv is exposed to any OpenAI client as `codiv:diffusiongemma-26b` with no
  serve-side changes.

### Fixed

- **onemin tool-call template** — the prompt example shown to 1min models
  had literal `MUN` where the `<tool_call>`/`</tool_call>` tags belong (the
  only non-OpenAI adapter's emulated tool-calling degraded silently), and
  the test asserted the broken string. Fixed, and a drift-guard test now
  requires the rendered example to round-trip through the parser, so the
  doc and the parser cannot diverge again.
- **`src/lib` registry fork** — the library export carried its own copy of
  the provider registry and free chain, ~20 providers and one free-chain
  prune behind the CLI (nvidia pointed at the wrong host and default
  model). Both tables now live in Node-free leaves (`provider-registry.ts`,
  `free-chain.ts`) shared by the CLI and the lib (the Workers bundle must
  not touch `node:fs`); the facade is pinned by drift-guard tests, one of
  which statically walks the lib's import graph asserting no `node:` import.
- **`read` binary files** — a null-byte sniff (same heuristic `search`
  uses) refuses images/fonts/archives with a hint instead of pushing
  mojibake into the transcript.
- **`edit` line endings** — the whitespace-insensitive fallback rewrote
  CRLF files with the model's LF newString, mixing endings (the old test
  baked the bug in). The rewrite now normalizes to the file's dominant
  EOL; LF files are untouched.
- **`search` skip list** — `target`/`vendor`/`__pycache__`/`build` now skip
  like `node_modules`, so build trees stop eating the 2,000-file budget
  before real source. Policy-configurable skip-dirs would extend the
  frozen schema (needs a recorded ruling); the built-in list is the honest
  slice.
- **Dead code** — unused `budget.ts` exports and the vestigial TUI budget
  cards (`setBudget`/`updateBudgetChild` were never called; budget info
  flows as text events) removed.
- **Auto-recovery for failed models (explore/exploit)** — the success-rate
  gates that steer auto away from unhealthy routes aggregated **lifetime**
  records, so a bad hour could lock a model out of auto indefinitely:
  excluded from auto, it never earned the calls that would rehabilitate it.
  serve's `model: "auto"` and `CODEWHIP_AUTO_RANDOM=1` now judge on a rolling
  last-20-call window (recency dominates — recovery is immediate), treat a
  record older than 24h as unproven rather than condemned (staleness reset),
  and CLI random mode spends ~10% of picks (all of them when nothing passes)
  on gated-out-but-eligible models as exploration probes, noted on the
  receipt. Lifetime aggregates on the health page and in metrics unchanged.

### Security & integrity (Linus-review pass, same release)

- **The npm library amputated** — `src/lib` was a phantom product: zero in-repo consumers, a placeholder proxy returning fabricated completions, a Workers path broken twice (`process.env` in KV storage, `build:lib` failing on the shared registry leaves), and routers/price tables drifted from the CLI. Deleted along with `workers/` and the exports map; `serve` remains the only proxy and the package is CLI-only.
- **Repeat-memo redaction bypass closed** — the memo stored raw tool output before redaction, so an identical second call replayed secrets unredacted and hashed different bytes than the first call. Redaction now happens before anything downstream; the repeat's `result_hash` matches the original byte-for-byte. The memo is also cleared on successful `bash` (stale reads after `npm pkg set`/`git checkout` corrupted edits).
- **Denylist spelling escapes closed** — `git.exe push --force`, quote-spliced `g"it" push --force`, `cmd.exe /c …`, and PowerShell-native code executors (`iex`, `invoke-expression`, `start-job`, `invoke-command`, `add-type`) all sailed past the "non-overridable" matcher. Matching now normalizes spelling (quotes stripped, `.exe/.com` suffixes dropped), those heads are denied outright, and script blocks / brace payloads are denied on the bash path (`denylist:script-block`). The `--yolo` banner now states the true claim instead of "never bypassed".
- **Audit chain: silent loss + forgeable prefix fixed** — the lock spin budget was shorter than the stale-lock threshold, so entries were silently dropped under contention (with the chain staying "verifiable" — history the verifier cannot know existed). The spin now exceeds the threshold, failures are surfaced in the run summary and as an additive `audit_dropped` field on the outcome record, and the tail read inside the lock is O(1). `init` appends a signed genesis marker bounding the pre-key unsigned prefix (and upgrades legacy chains), so prepend-forgery after the signed era is detectable instead of forgiven unboundedly.
- **Rotation × live `/model` bug fixed** — rotation candidates were bare model ids resolved against whatever port was current; after `/model groq`, a 429 sent head-provider model ids to groq and the run died on a foreign-id 404. Candidates are now pre-resolved head-provider targets gated on the provider label, and a terminally failed turn that had a switch applied says so in the error.
- **Background tasks kill the whole process tree** — `taskkill /pid /T /F` on win32 (process-group kill on POSIX); previously every timed-out background task orphaned its descendants (the dev server kept the port), and `task_stop`'s "sent SIGTERM" was a POSIX lie on Windows.
- **Compaction is model-aware and CJK-honest** — optional verified `contextWindow` on provider rows (0.7× ceiling; unverified stays the default 60k — never fiction), non-ASCII codepoints count ~1 token each (plain chars/4 underestimated CJK ~4×), and context-overflow 400s join the rotation/hop path instead of killing `--free` runs terminally on small-window relays.
- **Smalls** — delegate specs no longer claim child webfetch (the loop denies it); the repeat nudge appends after the content instead of replacing it; retry-wait drops the redundant hop-count gate; `read`/`edit` refuse ordinary secret files (`.envrc`, `id_rsa`, `id_ed25519`, `.npmrc`, `secrets.yaml`); `policy.md` is self-protected from checkpoint restore; `find` left the memorable-grants curation (`-exec` is an executor primitive) and a stored `npm run *` grant now prints its compose risk; fakePort gained strict over-consume mode.

### Changed

- **Package identity** — npm name `codewhip-proxy` → `codewhip`
  (description, keywords, duplicate `engines` key fixed; `prepublishOnly`
  runs lint+typecheck+build+test; the `tasks/` fixtures ship in the
  package). README quickstart documents the `npm i -g codewhip` /
  `npx codewhip` path alongside clone-and-build.

## [0.2.0] — 2026-09-13

### Added

- **Subagents & delegation** (`delegate`, `delegate_many` tools): the parent loop can spawn read-only child runs for exploration, review, and multi-perspective convergence. Agents are declarative: three built-ins (`explore` — find and report with file:line evidence; `review` — adversarial findings with severity; `plan` — an ordered implementation plan) plus `.codewhip/agents/<name>.md` files (flat frontmatter: `description` required, optional `model` served on the parent's port, optional `max_steps` ≤ 25; body = the child's system prompt; a file overrides a same-name built-in). The design beats the competition's failure modes: children run with plan-mode semantics (edit/write/bash/delegate refused pre-ladder — no ask prompts inside children, the known Claude-Code/Codex UX hole), fresh transcripts (no context bloat), summary-only returns, and a hard depth cap of 1. Where the competitors' child runs are black boxes, every codewhip child tool call lands on the global hash-chained audit log under the child's own runId, the child writes its own `outcomes.jsonl` record, and its tokens fold into the parent's receipt buckets — delegation spends the parent's budget honestly, never off-book. `delegate_many` fans up to 4 children concurrently and returns ordered reports; child progress is forwarded to the run's event stream prefixed `[<agent>]`. The delegation roster rides the parent's system message; `delegate` calls are `allow:delegate:read-only` on the audit trail (delegation grants no authority beyond read/search/webfetch) and are never memoized.
- **Trust certificate** (`codewhip trust [--json] [--verbose]`): one command printing the repo's trust state — audit chain INTACT/BROKEN (pre-key unsigned entries handled honestly), base + promoted deny counts, polish gate evaluated from real polish runs, remembered-rule count, keys split usable (env/file) vs anonymous (rate-limited) vs missing, and a `TRUST: PASS|NEEDS WORK` verdict with contextual next-step commands (only what's actually missing). `--json` for CI/automation; `--verbose` reveals the missing-key list.
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
