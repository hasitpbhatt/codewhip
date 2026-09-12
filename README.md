# CodeWhip — crack through code like a whip

[![ci](https://github.com/hasitpbhatt/codewhip/actions/workflows/ci.yml/badge.svg)](https://github.com/hasitpbhatt/codewhip/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> The terminal agent a team lead can let an intern run on prod-adjacent
> code at 2am — policy-checked, memory-scoped, replayable, metered.

CodeWhip is an **open, model-agnostic, local-first terminal coding agent**
(an OpenCode equivalent for the CLI), built around one wedge the incumbents
leave open: **Governance + Trust**. OpenCode optimizes for freedom;
Claude Code optimizes for capability inside a closed box. Neither optimizes
for *delegatability*. CodeWhip does.

**Status: MVP loop live.** `codewhip run` runs a real agent loop
(`read/search/edit/write/bash/webfetch`, policy-checked, metered, replayable);
`init`/`auth`/`models`/`audit` ship; a $0-quota test suite pins the
policy, jail, memory, audit chain, share redaction, router, metrics, promotion, packs, and loop. The five Naval agents have debated and
converged on the full strategy (`docs/moat/`), and the build order is fixed
(`docs/roadmap.md`).

## Why CodeWhip

| Incumbent | Strength | Gap CodeWhip attacks |
|---|---|---|
| OpenCode | Open, 75+ providers, fast shipping | Permissions are a safeguard, not a sandbox; state doesn't compound; no audit/SOC2 story |
| Claude Code | Enterprise trust, workflow revenue | Closed, provider-locked, expensive (~$5/M vs ~$0.12/M routable), harness leaked |
| Cursor-style | Distribution + data flywheel | IDE-bound, telemetry-based, not yours |

The moat ranking we build by: **memory > governance > execution >>
connectors**. Anything that doesn't get more valuable the longer a customer
uses it doesn't ship in H1.

## Quickstart

```sh
npm i -g codewhip
codewhip init                      # 30s: AGENTS.md + codewhip-policy.yaml + local signing key
codewhip auth login mistral        # optional; every provider needs a key (see "Provider keys")
codewhip run "fix the failing test"
codewhip run "refactor auth" --token-budget 250000
codewhip run "refactor auth" --share    # + redacted share bundle (.codewhip/share-<runId>.json)
codewhip audit --last 20           # tail the hash-chained audit log
codewhip audit --verify            # re-walk seq/prev_hash + ed25519 signatures
codewhip audit --replay 20         # readable action replay (newest last)
codewhip audit --export            # signed content-addressed bundle for an auditor
```

Every run prints receipts: `tokens / model mix / $`.
The token budget is **enforced mid-run**, not a preflight fiction — when the
run crosses it, CodeWhip stops, keeps the partial transcript, and prints the
receipt anyway.

## How it works (design)

- **Loop:** `prompt → stream LLM → permission check → exec → append → repeat`,
  Ctrl-C safe, `--max-steps 25` hard stop. Five tools: `read`, `search`
  (glob+grep), `write` (create/overwrite, refuses harness state), `edit`,
  `bash` (real shell); git (`status`/`diff`) rides the bash allowlist rather
  than a sixth tool. Tool output is capped at transcript push (4000 chars) so
  one runaway command can't flood the context window.
- **Policy:** harness-side, never in the prompt (0 tokens for rules).
  Non-overridable denylist + explicit deny on shell chaining
  (newlines, `;`, `|`, `&`, `` ` ` ``, `$()`) — a smuggled
  `git status\nrm -rf .git` is denied, never allowed. Defaults: read allow,
  edit/write/shell ask, external denied. `--yolo` bypasses ask — never the
  denylist.
- **Memory:** files-first and git-native. "Always allow" (`a` at the prompt)
  stores a **curated shape** in `.codewhip/remembered.jsonl` with provenance
  (`ts/runId/preview_hash`) — only safe heads are memorable, redirects and
  chains never are, and `.codewhip/**`/`codewhip-policy.yaml` self-protect.
  No vector DB until >500 outcomes prove the pain.
- **Audit:** `.codewhip/outcomes.jsonl` is written every run
  (usageByModel, failovers, per-tool allow/deny + ruleIds). Every tool call is
  also appended to the hash-chained `.codewhip/audit.log`
  (`seq/ts/actor/tool/args_hash/result_hash/prev_hash/policy/sig`), ed25519-signed
  with the `init` keypair (`sig: null` in unsigned repos). The log stores hashes
  only — never raw args or output — so redaction-at-write holds by construction.
  `audit --verify` re-walks the chain and signatures; `--replay` renders it;
  `--export` writes a signed content-addressed bundle. Tail tampering is
  anchored by the bundle's `chain_tail`; non-tail tampering breaks the next link.
- **Share:** `run --share` writes `.codewhip/share-<runId>.json` — prompt,
  per-tool previews, policy verdicts, receipt — scrubbed twice (key-shaped
  tokens/PEMs/emails plus env-assignment values, names kept), anchored to the
  audit chain (`audit_tail`) and signed when a key exists. Local-file v1: no
  upload, no server; the "link" is the bundle path plus its content hash.
- **Router:** 3 task classes (implement → nvidia free tier, polish →
  sensenova cheapest inference, private → local). Auto-classified from the
  prompt (private signals win, then polish, else implement) with the reason
  printed; `--class`/`--provider`/`--model` always override. Private prompts
  refuse cloud routing unless you name a provider explicitly (informed
  consent). Polish runs print a gate line (`PASS` only on a priced route
  <$0.05; `OPEN` while costs are untracked). `--token-budget` enforced mid-run
  (default 250000), same-provider `--models a,b,c` rotation and one-shot
  `--failover`/`--retry-wait` on 429 only.
- **Sandbox:** v1 = Node path jail (realpath, symlink-aware) + non-overridable
  denylist; v2 swaps the executor (E2B/Firecracker) behind the frozen
  policy/audit schema.

## Repo map

```
src/index.ts            CLI entry (help, run/auth/models/audit)
src/loop.ts             agentLoop(): stream → permission → exec → append, budget
src/policy.ts           harness policy: denylist, chaining-deny, ask/allow defaults
src/policy-store.ts     policy.md promoted denies (declines → candidates → approve)
src/pack.ts             team policy packs shipped locally (list/pull)
src/router.ts           3-class task router (implement/polish/private) + polish gate
src/metrics.ts          `codewhip metrics`: blocks/100, $/task, memory/week from outcomes
src/remember.ts         curated memorable shapes (no redirects/chains)
src/remember-store.ts   .codewhip/remembered.jsonl (provenance: ts/runId/preview_hash)
src/tools/              read/search/write/edit/bash/webfetch + jail
src/testkit/            $0 fake ChatPort for the test suite
src/auth.ts             provider keys (login/logout/status; env wins, file 0600)
src/config-dir.ts       global key/config dir (%APPDATA% | ~/.config)
src/custom-providers.ts user-registered OpenAI-compatible providers
src/models.ts           served-model listing with agency tags
src/provider.ts         builtin registry + ChatPort adapter
src/audit.ts            hash-chained signed audit log
src/outcomes.ts         outcomes.jsonl per-run records
src/redact.ts           key/secret scrubber (share + audit previews)
src/share.ts            redacted chain-anchored share bundles
src/verdict.ts          human verdicts sidecar (accepted/edited/reverted/rejected)
src/system.ts           system prompt (harness rules stay out of it)
src/demo.ts             offline wedge demo ($0 fake port)
src/hash.ts             sha256 helpers
SOUL.md                 product conscience (read this first)
docs/roadmap.md         the consolidated build order (H1/H2, kill list, metrics)
docs/moat/00-convergence.md   the 7 debate rulings (no ties)
docs/moat/01-leverage.md      minimal loop + router economics
docs/moat/02-memory.md        compounding memory + flywheel
docs/moat/03-governor.md      policy schema + audit + sandbox
docs/moat/04-scout.md         wedge defense + terminal-first GTM
docs/moat/05-h1-audit.md      four-lens H1 gap audit
docs/moat/06-post-h1-verdict.md   five-lens post-H1 verdict (code, not claims)
AGENTS.md               working agreement for coding agents
```

## Roadmap (abridged)

- **H1 (parity + trust):** `agentLoop()` → five tools → 8 providers + custom registration + meter →
  policy jail + denylist + chaining-deny → curated remembered-shape memory
  (provenanced) → hash-chained audit → `init`/`run`/`--share` (local redacted
  bundles; hosted links need a server) →
  3-class router with <$0.05 polish receipt → GitHub Action + 1 starter pack.
- **H2 (past Claude):** sandbox profiles, pack registry + SSO/retention (paid),
  graph memory on proven pain, full provider matrix, auditor bundle v2,
  TUI/desktop/IDE only after terminal trust compounds.
- **Never (kill list):** model hosting/training, MCP catalog, SQLite/vector DB
  in H1, subscription hiding the meter, yolo-by-default, public launch before
  the meter proves itself. Full list in `docs/roadmap.md`.

## Development

```sh
npm install
npm run dev        # tsx src/index.ts (no build, fastest local loop)
npm run build      # tsc -> dist/
npm run typecheck  # tsc --noEmit
npm test           # $0-quota suite: tsx --test src/**/*.test.ts
```

Requires Node >= 22. TypeScript strict, ESM.

### Install globally (use `codewhip` from any path)

One-time (global bin `C:\Users\Lenovo\AppData\Roaming\npm` is already on your `PATH`):

```sh
npm install
npm run build
npm link           # symlinks global `codewhip` -> this repo's dist/
```

Then open a **new terminal** and verify from any directory:

```sh
codewhip help
codewhip run "fix the failing test"
```

Remove it with `npm unlink -g codewhip`.

### Fast iteration (link once, rebuild on save)

`npm link` points at `dist/`, so rebuild after each `src/` change — easiest is one watcher terminal:

```sh
# terminal A (leave running in repo root):
npm run build -- --watch   # tsc --watch: rebuilds dist/ on every save, link stays valid

# terminal B (any path):
codewhip run "fix the failing test"
```

Alternative without watch mode: `npm run build` manually after each change, or skip the link entirely with `npm run dev -- run "fix the failing test"`.

### Provider keys (persistent, per provider)

```sh
codewhip auth login            # nvidia: hidden prompt, paste once; stored 0600 outside the repo
codewhip auth login mistral    # same for mistral (no default stored; key only)
codewhip auth status           # per provider: set (source: env|file) or missing — never prints keys
codewhip auth logout mistral   # deletes the stored key (re-run login to rotate)
codewhip run "Say OK"                              # nvidia default (kimi-k3, free tier $0)
codewhip run "Say OK" --provider mistral           # mistral default (mistral-small-latest)
codewhip run "Say OK" --provider sensenova         # sensenova default (sensenova-6.8-flash-lite)
codewhip run "Say OK" --provider alibaba           # alibaba default (qwen-plus)
codewhip run "Say OK" --provider llm7              # llm7 gateway default (works with no key: anonymous, rate-limited)
codewhip run "Say OK" --provider tokenharbor       # tokenharbor orchestrator (needs a key: free account works)
codewhip run "Say OK" --provider bai               # bai gateway default (needs a key: credit billing, paid)
codewhip run "Say OK" --provider fabryka           # fabryka router default (needs a key: free key, reasoning model)
```

Keys: nvidia free at `https://build.nvidia.com/settings/api-keys` (~40 req/min, $0); mistral at `https://console.mistral.ai` (free mode is evaluation-grade: RPS + tokens/min + tokens/month caps — check Limits); sensenova at `https://token.sensenova.ai`; alibaba at `https://dashscope-intl.aliyun.com`; llm7 tokens at `https://dash.llm7.io` (anonymous `unused` works keyless, heavily rate-limited); tokenharbor keys at `https://tokenharbor.ai/dashboard/api-keys` (free account works, `thk_…`); bai keys at `https://chat.b.ai/chat` (log in, top up credits — paid, metered per model); fabryka keys at `https://router.fabryka.ai` (free key, then $0.20/$0.60 per 1M in/out — single `qwen3.6-35b-a3b` reasoning model, keep concurrency at 1). Env (`NVIDIA_API_KEY`/`MISTRAL_API_KEY`/`SENSENOVA_API_KEY`/`ALIBABA_API_KEY`/`LLM7_API_KEY`/`TOKENHARBOR_API_KEY`/`BAI_API_KEY`/`FABRYKA_API_KEY`) wins when set (CI-friendly). Receipts show `tokens / provider:model / cost`; only nvidia is known-$0 — other providers print "cost untracked" pointing at their console. The key file lives in `%APPDATA%\codewhip` (Windows) or `~/.config/codewhip` (posix) — filesystem permissions, not encryption; on shared machines prefer the env var.

### Custom providers (any OpenAI-compatible endpoint)

```sh
codewhip provider list
codewhip provider add my-gateway --base-url https://gateway.example.com --model my-model --env-var MY_GATEWAY_API_KEY --key-url https://gateway.example.com/keys
codewhip auth login my-gateway                     # same key flow as builtins (env MY_GATEWAY_API_KEY wins)
codewhip run "Say OK" --provider my-gateway
codewhip models my-gateway
codewhip provider remove my-gateway
```

Registration is validated (`https://` base, `UPPER_SNAKE` env var, 5s–120s timeout) and stored keyless in `custom-providers.json` next to the key file — `--failover`, `--provider`, and `models` all see customs. Anything not OpenAI-compatible (`/v1/chat/completions` + Bearer) needs an adapter, not a table row.

### Undo anything: automatic checkpoints + `codewhip rollback`

Every `edit`/`write` is snapshotted before it happens (before-image +
sha256 manifest under `.codewhip/checkpoints/<runId>/` — flat JSONL files,
self-protecting: harness state is never checkpointed). Runs that touched
files print `checkpoints: N file(s) snapshotted — undo: codewhip rollback
<prefix>`, and one command restores the pre-run state:

```sh
codewhip rollback --list        # runs with checkpoints
codewhip rollback e029e31f      # restore every file that run touched
```

Rollback verifies every snapshot hash *before* touching a byte (a tampered
checkpoint refuses the whole restore, never half-applies), restores
newest-to-oldest so the earliest content wins, removes files the run
created, and lands on the hash-chained audit trail like everything else.
The intern at 2am has an undo.

### Plan before act: `--plan`

Review step for the whole task, the way `edit` has `ask`:

```sh
codewhip run "migrate auth to sessions" --plan
```

The run is **read-only**: `edit`/`write`/`bash` are refused by the harness
for the entire run — above `ask`, above `--yolo`, above remembered rules,
nothing can grant them. `read`/`search`/`webfetch` stay allowed, so the
agent can investigate freely; the run's final output is the implementation
plan, which you review, then re-run without `--plan` to execute it. The
banner prints `!! --plan armed` up front and every refusal lands on the
audit trail as `deny:plan:read-only`.

### Free models at one place

`codewhip free` lists the free-provider chain read-only (no key, no network):
what each gateway offers, whether it needs a key, its limits as verified on
2026-09-11, and where to get the key. Keyless rows print first.

`codewhip run "..." --free` arms the whole chain on one run: on a
rate-limit/timeout the loop hops down the chain in order (same semantics as
`--failover`, each provider at most once per run), it only walks free
providers it can authenticate, and it **never bills pay-go**. The head is
your explicit `--provider` (must be a free-catalog id) or the first free
candidate with a usable key; the keyless tiers lead the chain, keyless `llm7`
is the floor, so a run still moves when every stored key is gone. `--free`
and `--failover` are mutually exclusive, and naming a non-free provider is
refused: `--free runs the free chain only`.

The 8 free gateways added to the builtin registry — 4 of them run with **no
key at all**:

| Provider | Keyless? | Env var | Key URL |
|---|---|---|---|
| kilo | yes — `:free` models are fully anonymous | `KILO_API_KEY` (optional) | https://kilo.ai |
| opencode | yes — Zen's anonymous `public` key + identity headers, handled by codewhip | `OPENCODE_API_KEY` (optional) | https://opencode.ai/zen |
| empero | yes — openly free endpoint (`free` placeholder key) | `EMPERO_API_KEY` (optional) | https://free.empero.org |
| groq | free key required | `GROQ_API_KEY` | https://console.groq.com/keys |
| cerebras | free key required | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai |
| openrouter | free key required | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| gemini | free key required | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| zai | free key required | `ZAI_API_KEY` | https://z.ai |

Every free-tier default is priced `$0` on the receipt — never fiction-priced,
and non-free models on the same gateway print `cost untracked`.

Honest notes: free tiers are **rate-limited** (openrouter: 50 req/day without
credits; groq: ~30 req/min per model; opencode zen: small per-IP anonymous
quota). Free-model status can be **time-limited** (zai's `glm-5.3-flash` is a
promo — expect quota errors when it ends) and endpoints can vanish (empero
was in maintenance at the 2026-09-11 probe). Free tiers may use your data for
**provider-side model improvement** — never send private or production code
on free tiers.

### Surviving rate limits (opt-in, off by default)

```sh
codewhip run "..." --retry-wait   # one Retry-After wait (<=60s) on 429 per run; avoid in CI
codewhip run "..." --failover     # one switch to the next provider with a stored key on 429 per run
codewhip run "..." --provider mistral --models mistral-small-latest,mistral-medium-latest,ministral-14b-latest
                                  # walk models in order on 429, each once per run (order: wait, rotate, failover)
```

Both wait and switch are 429-only: auth, 5xx, and timeouts never trigger them. `--failover` needs the other provider's key up front (aborts otherwise — it never runs keyless), starts from the provider default (drop `--model`, or lead `--models` with it), and banners because it may bill pay-go. Keep completion-refusers like `codestral-latest` out of agent chains: it answers but won't call tools for file work. Receipts show the per-model mix whenever a run crosses models or providers.

### Approvals that stick ("always allow")

Every `edit`/`write`/`bash`/`webfetch` call that policy asks about prompts:

```
allow bash echo 'x' >> TEST.md? [y/N/a]
```

- `y` — allow once. `N` (or anything else) — deny once, model gets told.
- `a` — allow once **and remember the shape** in `.codewhip/remembered.jsonl`
  with provenance (`ts`, `runId`, `preview_hash`). Shapes are **curated**:
  only a short allowlist of heads is memorable (`git status/diff/log/branch`,
  `npm test/run`, `npx tsx/tsc`, `ls`, `cat`, `echo`, …). Redirects, pipes, and
  chains (`;`, `&`, `|`, newlines, `>`, `>>`) are never memorable; a `bash:echo *`
  shape matches `echo x`, never `echo x >> .git/hooks/…`. `edit`/`write` shapes
  are exact paths. `webfetch` shapes are bare https origins — one `a` covers
  every path under the host, never the query string. Future calls with a
  matching shape auto-allow and the audit
  shows `default:shell:ask+remembered` — visible, attributable, never silent.
- Targets that the harness must protect (`.codewhip/**`, `codewhip-policy.yaml`,
  `remembered.jsonl` itself) refuse `a` outright — the `write` tool and the
  memory both self-protect.
- The denylist and the chaining-deny win over every remembered rule.
  `--yolo` bypasses ask but never the denylist.

### Promotion: declines that become policy

Decline the same shape 3+ times and it becomes a candidate:
`codewhip policy candidates` lists them, `policy approve "<tool:shape>"`
appends a `deny` line to `policy.md`, and from the next run that shape is
refused pre-flight (before any token burns) with rule pointer
`policy.md:deny:<tool>:<shape>`. `policy list` shows what's promoted.
`policy.md` honors only `deny` lines — promotion can refuse, never permit —
and the non-overridable denylist still wins over it.

### Team packs + CI

`codewhip pack list` shows packs shipped with the install;
`pack pull starter` copies the starter `policy.md` (publishing / infra /
secret-file denies) into your repo. Local-file v1 — no registry, no network.
`.github/workflows/ci.yml` pins lint (node 22) + typecheck + tests + build on Node 22/24;
`actions/run/action.yml` runs the agent headless in CI (ask⇒deny by
construction, never `--yolo`) and uploads `.codewhip/` as the audit artifact.
PR commenting is deliberately unwired in v1 — review the trail first.

**Token cost: exactly zero.** Policy is enforced harness-side in
`src/policy.ts` / `src/remember.ts` — the model never receives the rules, not
even a summary; the system prompt only tells it "the harness blocks destructive
commands". Policy can grow without touching prompt tokens, and the model can't
talk its way around rules it has never seen.

Remove a rule by deleting its line from `.codewhip/remembered.jsonl`
(one JSON object per line; the file is gitignored with the rest of
`.codewhip/`).

## Strategy notes

The product strategy was debated by five Naval personas and converged in
`docs/moat/00-convergence.md` — read the rulings before proposing direction
changes. The personas themselves are local dev tooling (`.opencode/`,
gitignored), not shipped.

## Contributing & Security

Bug reports and feature requests:
[issues](https://github.com/hasitpbhatt/codewhip/issues). Vulnerabilities
(jail escape, audit forgery, redaction leak) go to private email — see
[SECURITY.md](SECURITY.md). Dev setup, commit style, and the PR checklist:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
