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

**Status: H1 DONE (2026-09-17).** `codewhip run` runs a real agent loop
(`read/search/edit/write/bash/webfetch`, policy-checked, metered, replayable);
`init`/`auth`/`models`/`audit` ship; the launch gate passed on a real priced
run (polish auto-route fixed 12 typos to verdict `accepted` at $0.0000).
A $0-quota test suite pins the
policy, jail, memory, audit chain, share redaction, router, metrics, promotion, packs, and loop. The five Naval agents have debated and
converged on the full strategy (`docs/moat/`), and the build order is fixed
(`docs/roadmap.md`).

## Contents

- [Why CodeWhip](#why-codewhip)
- [Quickstart](#quickstart)
- [How it works (design)](#how-it-works-design)
- [Roadmap (abridged)](#roadmap-abridged)
- [Development](#development)
- [Provider keys](#provider-keys-persistent-per-provider) · [Custom providers](#custom-providers-any-openai-compatible-endpoint) · [Undo](#undo-anything-automatic-checkpoints--codewhip-rollback) · [`--plan`](#plan-before-act---plan) · [Subagents](#subagents-explore-review-and-converge-in-parallel) · [Sessions](#keep-the-conversation-going---continue) · [Free models](#free-models-at-one-place) · [Serve](#serve-every-provider-as-an-openai-endpoint) · [Rate limits](#surviving-rate-limits-opt-in-off-by-default) · [TUI slash](#tui-slash-commands) · [Approvals](#approvals-that-stick-always-allow) · [Promotion](#promotion-declines-that-become-policy) · [Packs + CI](#team-packs--ci) · [Measure](#measure-it-eval-metrics-verdict)
- [Strategy notes](#strategy-notes)
- [Contributing & Security](#contributing--security)

## Why CodeWhip

OpenCode optimizes for freedom, Claude Code for capability inside a closed
box. Neither optimizes for *delegatability* — the moment a team lead trusts
the tool in a junior's hands unsupervised, on prod-adjacent code at 2am.
CodeWhip does: policy-checked, memory-scoped, replayable from a redacted
audit link, metered to <$0.05 on polish work.

The moat ranking we build by: **memory > governance > execution >>
connectors**. Anything that doesn't get more valuable the longer a customer
uses it doesn't ship in H1.

## Quickstart

Install (once published, `npm`-style; today: clone-and-build, both give the same `codewhip` command):

```sh
# option A — from npm (after the first published release)
npm install -g codewhip
# or run without installing:
npx codewhip demo --deny

# option B — from source (works today)
git clone https://github.com/hasitpbhatt/codewhip
cd codewhip && npm install && npm run build
npm link   # optional: puts `codewhip` on PATH from this repo's dist/
```

Then, in any repo you want the agent to work on:

```sh
codewhip init              # 30s: AGENTS.md + codewhip-policy.yaml + local signing key
codewhip demo --deny       # offline wedge demo: 5 disasters refused, $0, no key
codewhip run "fix the failing test" --free   # keyless first success (free chain, never bills)
codewhip auth login nvidia # default provider needs a key (free at build.nvidia.com) — or keep using --free
codewhip run "fix the failing test"
codewhip run "refactor auth" --token-budget 250000
codewhip trust             # needs init + one run first: chain, policy, keys, memory — one command
codewhip remember list     # what the agent auto-runs without asking (revoke: remember forget)
codewhip audit --verify    # re-walk seq/prev_hash + ed25519 signatures
```

(If you installed from source without `npm link`, `node dist/index.js …`
from the repo root is the command. `npm run dev -- …` skips the build.)

Every run prints receipts: `tokens / model mix / $`. Receipts price known
$0 routes (nvidia and the verified free-chain defaults); unpriced routes
say `cost untracked` and point at the provider console — never fiction.
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
- **Router:** 3 task classes (implement → nvidia free tier, polish → kilo
  priced $0, private → a local runtime you registered).
  Auto-classified from the
  prompt (private signals win, then polish, else implement) with the reason
  printed; `--class`/`--provider`/`--model` always override. Private prompts
  route only to a **loopback** provider; with none registered they refuse
  cloud routing unless you name a provider explicitly (informed
  consent). Polish runs print a gate line (`PASS` only on a priced route
  <$0.05; `OPEN` while costs are untracked). `--token-budget` enforced mid-run
  (default 250000), same-provider `--models a,b,c` rotation and one-shot
  `--failover`/`--retry-wait`/`--free`/`--auto-failover` on rate-limit,
  timeout, or 5xx (waits via `--retry-wait` stay 429-only).
- **Sandbox:** v1 = Node path jail (realpath, symlink-aware) + non-overridable
  denylist; v2 swaps the executor (E2B/Firecracker) behind the frozen
  policy/audit schema.

## Roadmap (abridged)

- **H1 (parity + trust):** `agentLoop()` → five tools → 134 providers + custom registration + meter →
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

Requires Node >= 22 for development (`npm test` needs the Node 21+
test-runner globs; CI pins 22/24). The built CLI (`node dist/index.js`)
runs on Node >= 20 (`engines` floor). TypeScript strict, ESM.

### Install globally (local dev only — use `codewhip` from any path)

```sh
npm install
npm run build
npm link           # symlinks global `codewhip` -> this repo's dist/
```

Then open a **new terminal** and verify from any directory:

```sh
codewhip help
codewhip run "fix the failing test" --free
```

Remove it with `npm unlink -g codewhip`. `npm link` needs a writable
global bin and does not survive ephemeral filesystems — on Replit, CI, or
any machine where `-g` fails, skip it and run `node dist/index.js …` from
the repo root instead (same binary, no link).

### Run on Replit

Import the GitHub repo, then in the Shell:

```sh
node -v              # need >= 20 to run, >= 22 for npm test
npm install
npm run build
node dist/index.js demo --deny
node dist/index.js run "fix the failing test" --free
```

Notes: never `npm link` or `npm i -g` on Replit (no persistent global
bin). The key file (`~/.config/codewhip`) is ephemeral on Replit — set
provider keys as Replit Secrets (env vars win over stored keys, e.g.
`NVIDIA_API_KEY`), or just stay on `--free`/keyless providers.

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
codewhip auth login            # nvidia: hidden prompt, paste once; stored owner-only outside the repo
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

The bare default (`run` with no flags) routes to nvidia and needs its key — for a $0 start with no keys use `run "…" --free` (free chain, never bills) or `--provider llm7` (anonymous, rate-limited). Env wins when set (CI-friendly; every env var is in the table below). Receipts show `tokens / provider:model / cost`; known-$0 routes (nvidia, kilo, the verified free-chain defaults) price exactly, everything else prints `cost untracked` pointing at its console — never fiction. The key file lives in `%APPDATA%\codewhip` (Windows) or `~/.config/codewhip` (posix) — owner-only permissions (0600 POSIX, user-only ACL on Windows, repaired on every write), not encryption; on shared machines prefer the env var.

### Custom providers (any OpenAI-compatible endpoint)

```sh
codewhip provider list
codewhip provider add my-gateway --base-url https://gateway.example.com --model my-model --env-var MY_GATEWAY_API_KEY --key-url https://gateway.example.com/keys
codewhip auth login my-gateway                     # same key flow as builtins (env MY_GATEWAY_API_KEY wins)
codewhip run "Say OK" --provider my-gateway
codewhip models my-gateway
codewhip provider remove my-gateway

# local runtime: http:// is allowed on loopback only, and needs no real key
codewhip provider add ollama-local --base-url http://127.0.0.1:11434 --model qwen3:35b --env-var OLLAMA_LOCAL_API_KEY
```

Registration is validated (`https://` base — or `http://` on **loopback only** — `UPPER_SNAKE` env var, 5s–120s timeout) and stored keyless in `custom-providers.json` next to the key file — `--failover`, `--provider`, and `models` all see customs. Anything not OpenAI-compatible (`/v1/chat/completions` + Bearer) needs an adapter, not a table row.

You can also add one without the terminal: while `codewhip serve` is running, open `http://127.0.0.1:8787/auth` — the key manager page carries the same form (id / base URL / default model / env var, optional paths and timeout under "optional"). A registered endpoint joins `/v1/models` immediately, and custom rows get a **remove** button. The API behind it is `POST /auth/_custom` and `DELETE /auth/_custom/<id>`; validation is the CLI's, so the two paths cannot disagree.

Loopback `http://` exists for local runtimes (Ollama `:11434`, vLLM `:8000`, LM Studio `:1234`), where the traffic provably cannot leave the machine. Any other host over plain `http://` is still refused — that would put your key on the wire in clear text. A loopback provider gets a placeholder credential, because every call path refuses an empty key while a local runtime wants none. These are also what the router's `private` class routes to, so the id must differ from any builtin: `ollama` is already the *remote* ollama-cloud service, so use e.g. `ollama-local`.

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

### Task lists

On multi-step work the model keeps a visible checklist with the `todo`
tool: `replace` the full plan up front, `update` statuses as steps
finish, `list` to re-read. The list lives in `.codewhip/todos.json` —
harness state, never a workspace file — so it is allow-by-default
(`default:todo:allow`, still deniable via a promoted `policy.md` rule),
redacted at save, and parent-run-only (children stay read-only).

### Subagents: explore, review, and converge in parallel

The model can spawn **read-only subagents** for investigation and
multi-perspective work — `delegate` runs one child, `delegate_many` fans up
to 4 out concurrently (the committee pattern: independent perspectives,
then converge):

```sh
codewhip run "review src/loop.ts for bugs"   # the model may delegate to `review`
codewhip run "compare auth approaches"       # or fan out explore/review/plan
```

Three built-ins ship zero-config: `explore` (find and report with
file:line evidence), `review` (adversarial findings, P0–P3), `plan`
(ordered implementation plan). Custom agents live in
`.codewhip/agents/<name>.md` — flat frontmatter (`description` required,
optional `model` served on the parent's port, optional `max_steps` ≤ 25)
and the body is the child's system prompt; a file overrides a same-name
built-in.

Why this doesn't dilute the trust model:

- children are **read-only and network-free** (read/search only —
  edit/write/bash/delegate/webfetch/todo refused pre-ladder; nothing inside a
  child can prompt, mutate, delegate, or reach the network — the parent
  fetches and passes content) and depth-capped: subagents cannot spawn
  subagents;
- every child tool call lands on the **global hash-chained audit log**
  under the child's own runId, and the child writes its own
  `outcomes.jsonl` record — nothing is a black box;
- child tokens fold into the parent's **receipt** (same buckets, honest
  `est.` marks) — delegation never spends off-book. Budgets are enforced,
  not just metered: the parent's remaining `--token-budget` is **split
  across entries** (85% children, 15% coordination reserve), each child
  enforcing its share live, and folded child spend can still trip the
  parent's check mid-run;
- children inherit the run's 429 defenses (`--models` rotation,
  `--retry-wait`) so a parallel fan-out on a rate-limited provider rotates
  instead of dying;
- child progress streams into your terminal prefixed `[<agent>]`, and the
  parent sees only the child's final report — its context stays clean.

`--plan` runs cannot delegate (read-only runs spawn no children), and a
child's `delegate` call is refused as `deny:loop:max-depth` even if a
rogue model asks for it.

### Sessions that survive their own context window (compaction)

Long runs die a quiet death: old tool outputs (file dumps, command logs)
crowd the context until the provider refuses the call. CodeWhip compacts
instead of dying. When a call's estimated size (chars/4, printed as
`est.` — no fake tokenizer precision) crosses the ceiling, the *oldest*
tail is pruned, never the working set:

1. old tool outputs are truncated to a 600-char head with a visible
   `…[compacted]` marker;
2. if that isn't enough, whole old exchanges are elided to stubs naming
   the tools they called — assistant + tool responses move as a block, so
   the transcript stays valid.

The system prompt, your original task, and the newest exchanges are never
touched, and every compaction prints an honest receipt:

```
◆ compacted: 2 old tool output(s) truncated, 1 exchange(s) elided (est. 8112 → 5990 tokens)
compacted: 2 old tool output(s) truncated, 1 exchange(s) elided across 1 compaction(s) — transcript kept under the context ceiling
```

On by default; the API takes `compactTokens: 0` to disable.

### Keep the conversation going (`--continue`)

```sh
codewhip run "add retries" --continue            # resume the most recent session
codewhip run "add retries" --continue 37b0       # resume one session (prefix >=4 chars, unique)
codewhip sessions                                # saved transcripts, newest first
```

`outcomes.jsonl` stores `prompt_hash`, never the raw prompt — so a saved
transcript is **opt-in only**: nothing is written unless `--continue` is
armed (the banner says `transcript saved on exit (raw prompts on disk)`).
Each run writes one `.codewhip/sessions/<runId>.json`
(`{ v: 1, ts, runId, provider, model, messages }`, `0600`, secrets redacted
at write time, system message stripped and rebuilt fresh on resume). The
saved transcript is the post-compaction one — exactly what the last provider
call saw — and lands on every exit path (success, error, cancel). The REPL
threads one in-memory transcript across lines and saves once on `.exit`.

### Free models at one place

`codewhip free` lists the free-provider chain read-only (no key, no network):
what each gateway offers, whether it needs a key, its limits as verified on
2026-09-11, and where to get the key. Keyless rows print first.

`codewhip run "..." --free` arms the whole chain on one run: on a
rate-limit, a timeout, or an upstream 5xx the loop hops down the chain in order
(same semantics as `--failover`, each provider at most once per run), it only
walks free providers it can authenticate, and it **never bills pay-go**. The
head is your explicit `--provider` (must be a free-catalog id) or the first free
candidate with a usable key; the keyless tiers lead the chain, keyless `llm7`
is the floor, so a run still moves when every stored key is gone. `--free`
and `--failover` are mutually exclusive, and naming a non-free provider is
refused: `--free runs the free chain only`.

`codewhip run "..." --auto-failover` is the same $0-only chain with a quiet
terminal: backend hops are recorded in the outcome/audit (and the receipt
still splits per model) but not printed — total exhaustion still reports
what was tried. Private runs stay head-only: explicit-provider consent
covers one cloud target, so there is nothing silent to hop to.

The 8 free gateways added to the builtin registry — 4 of them run with **no
key at all**:

| Provider | Keyless? | Env var | Key URL |
|---|---|---|---|
| kilo | yes — `:free` models are fully anonymous | `KILO_API_KEY` (optional) | https://kilo.ai |
| opencode | yes — Zen's anonymous `public` key + identity headers, handled by codewhip | `OPENCODE_API_KEY` (optional) | https://opencode.ai/zen |
| empero | yes — openly free endpoint (`free` placeholder key); ⚠ in maintenance, see note below | `EMPERO_API_KEY` (optional) | https://free.empero.org |
| groq | free key required | `GROQ_API_KEY` | https://console.groq.com/keys |
| cerebras | ⚠ no longer free — see note below | `CEREBRAS_API_KEY` | https://cloud.cerebras.ai |
| openrouter | free key required | `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| gemini | free key required | `GEMINI_API_KEY` | https://aistudio.google.com/apikey |
| zai | free key required | `ZAI_API_KEY` | https://z.ai |
| nvidia | free key required (~40 req/min, $0) | `NVIDIA_API_KEY` | https://build.nvidia.com/settings/api-keys |
| mistral | free key required (evaluation-grade free mode: RPS + tokens caps — check Limits) | `MISTRAL_API_KEY` | https://console.mistral.ai |
| sensenova | key required | `SENSENOVA_API_KEY` | https://token.sensenova.ai |
| alibaba | key required | `ALIBABA_API_KEY` | https://dashscope-intl.aliyun.com |
| tokenharbor | key required (free account works, `thk_…`) | `TOKENHARBOR_API_KEY` | https://tokenharbor.ai/dashboard/api-keys |
| bai | key required (paid, metered per model) | `BAI_API_KEY` | https://chat.b.ai/chat |
| fabryka | free key, then $0.20/$0.60 per 1M in/out (single reasoning model, concurrency 1) | `FABRYKA_API_KEY` | https://router.fabryka.ai |

A further **18 free-key tiers** joined the registry on 2026-09-13 (harvested
from freellm.net and peer directories, each cross-checked against a second
source): `cloudflare`, `modelscope`, `ovhcloud`, `ollama`, `cohere`,
`siliconflow`, `aionlabs`, `agnes`, `requesty`, `inference`, `hetzner`,
`venice`, `scaleway`, `friendli`, `nscale`, `nebius`, `ai21`, `coze`. All 18
require a key — none runs keyless — so they join a `--free` run only once you
add one. Their `defaultModel` values are catalog-derived rather than
live-probed (confirm with `codewhip models <id>`), and `cloudflare` additionally
needs `CLOUDFLARE_ACCOUNT_ID`, because Workers AI scopes its API by account id.

Three rows were repaired the same day because they had stopped being truthful:
`cerebras` (now needs a verified card, grant expires in 30 days) and `chutes`
(pay-per-token since 2026-03) both left the free chain — a `--free` run must
never bill — and `lepton` was removed outright (Lepton AI ceased operations
2025-05-20; `api.lepton.ai` no longer resolves). `cerebras` and `chutes` stay
usable via `--provider`; they are simply no longer *free*.

`1min` (2026-09-13) is the first builtin that is **not** OpenAI-compatible, so
it does not ride the shared HTTP port at all. Its row carries `port: "onemin"`
and `src/onemin.ts` translates: one flattened prompt string instead of a
`messages[]` array, an `API-KEY` header instead of `Bearer`, a required
`type: "UNIFY_CHAT_WITH_AI"` discriminator, the reply unwrapped from
`aiRecord.aiRecordDetail.resultObject`, and — because 1min returns no `usage`
block — token counts that are always labelled **estimated** on the receipt.

Because 1min has no wire-level function calling, tool use is **emulated**: tool
specs are rendered into the prompt and the model is asked to reply with
`<tool_call>{"name": …, "arguments": {…}}</tool_call>` blocks, which codewhip
parses back out. This is best-effort — it depends on the model cooperating. A
model that ignores the instruction degrades to plain text rather than failing.
Responses are non-streaming, because a `<tool_call>` block can be split across
SSE deltas and whole bodies keep the parse reliable. It is also credit-metered
from the first call (see the out-of-chain table below).

Beyond the chain, the registry holds **134 builtins** (`codewhip provider
list`; keys via `codewhip auth login <id>`): first-party labs and clouds
plus keyed aggregators, all reachable via `--provider`. The ones below stay
**out of the free chain** — each for a stated money reason, since `--free`
promises never to bill pay-go (that promise is structural: chain membership
requires a non-billing tier, which is why the one-time grants were removed
2026-09-18):

| Provider | Why out of the chain | Reach it |
|---|---|---|
| `1min` | credit-metered from the first call; also the only non-OpenAI builtin (`port: "onemin"` — flattened prompt, `API-KEY` header, emulated `<tool_call>` blocks, always-estimated tokens) | `--provider 1min`, key `ONEMIN_API_KEY` |
| `hcnsec` | New API relay; free allowance is a console quota, not a fixed grant | `--provider hcnsec`, key `HCNSEC_API_KEY` at `https://api.hcnsec.cn/console` |
| `hashneuron` | RouteOpen gateway; calls past the daily 500k grant draw on a paid balance instead of rate-limiting | `--provider hashneuron`, key `HASHNEURON_API_KEY` at `https://hashneuron.space/#keys` |
| `codiv` | diffusion-LM host; 10M-token grant "while the experiment runs" (renewability unconfirmed) | `--provider codiv`, key `CODIV_API_KEY` at `https://codiv.ai/signup` |
| trial-credit aggregators (`together`, `deepinfra`, `fireworks`, `cometapi`, `mkeai`, `apiyi`, `xai`, `novita`, …) | one-time signup grants are not free tiers | `--provider <id>` |
| `wrouter` (AccelsRouter) | trial credit for new accounts | `--provider wrouter`, key `WROUTER_API_KEY` at `https://router.accels.tech/register` |
| `arouter` (ARouter) | keyed gateway, no verified free tier | `--provider arouter`, key `AROUTER_API_KEY` at `https://api.arouter.ai` |

Relays and aggregators (`hcnsec`, `hashneuron`, community gateways) see every
prompt in plaintext — never send secrets through them. A relay's served set
shifts, so relay rows default to the gateway's own routing id (`auto`,
`default`) rather than a pinned model that would 404.

Every free-tier default is priced `$0` on the receipt — never fiction-priced,
and non-free models on the same gateway print `cost untracked`. A loopback local
runtime is priced `$0` too: that is a fact about your own machine rather than a
guess, and there is no provider console to go and check.

Honest notes: free tiers are **rate-limited** (openrouter: 50 req/day without
credits; groq: ~30 req/min per model; opencode zen: small per-IP anonymous
quota). Free-model status can be **time-limited** (zai's `glm-5.3-flash` is a
promo — expect quota errors when it ends) and endpoints can vanish. `empero` has
been in a **declared maintenance window** since at least 2026-09-11; re-probed
2026-09-14 it returns a consistent 503 with `code: "maintenance"` and the message
"we are switching the free endpoint to new models". It stays in the free chain
because it does not bill and the chain simply rotates past a failing hop — but
its own notice says the served **models are changing**, so both its
`defaultModel` and its `$0` price entry need re-verifying when it returns. Free
tiers may use your data for
**provider-side model improvement** — never send private or production code
on free tiers.

### Serve every provider as an OpenAI endpoint

```sh
codewhip serve                                  # http://127.0.0.1:8787, defaults to keyless llm7
codewhip serve --port 8787 --provider nvidia
codewhip serve --host 0.0.0.0 --token s3cret    # a non-loopback bind REQUIRES --token
```

`codewhip serve` exposes the whole registry over the OpenAI HTTP contract, so
any OpenAI client — or another agent framework — can use codewhip's providers
without knowing anything about them. This is what lets a client that cannot
speak 1min's schema still use 1min.

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"kilo:cohere/north-mini-code:free","messages":[{"role":"user","content":"hi"}]}'
```

Model routing is `"<provider>:<model>"`, split at the **first** colon so model
ids may keep their own (`kilo:cohere/north-mini-code:free`). A bare provider id
means that provider's default model; a bare model id goes to the server's
default provider. `GET /v1/models` lists every provider as
`<provider>:<default-model>`, and `GET /health` needs no auth. A request
with `"model": "auto"` (or a server started with `--provider auto`) hops
silently to the next healthy target on rate-limit/timeout/5xx — at most 3
upstream attempts, each failure server-logged, the winner named in
`serviced_by`. A pinned `provider:model` never hops: its failure is
returned as-is.

`GET /auth` is a small web page (on by default; `--no-auth-ui` disables it) that
sets and clears provider keys and registers custom endpoints from the browser —
`POST /auth/_custom`, `DELETE /auth/_custom/<id>`. It sits behind the same
loopback-or-token rule as the rest of the server.

The client always receives a well-formed OpenAI SSE stream, even when the
upstream is non-streaming — 1min's port never streams, and `--no-stream`
disables SSE globally, so the server synthesizes the deltas from the whole
response rather than leaking which upstream it landed on.

Two things to be clear about. First, this process spends **your keys** on behalf
of whoever can reach the port, so it binds `127.0.0.1` by default and refuses a
non-loopback bind without `--token`. Second, `serve` is a model proxy, not an
agent run: it executes no tools, applies no policy, and writes no audit
entries, because there are no tool calls to record. The client owns tool
execution and therefore owns its own safety story. Provider health is still
recorded in `codewhip stats`.

### Surviving rate limits (opt-in, off by default)

```sh
codewhip run "..." --retry-wait   # one Retry-After wait (<=60s) on 429 per run; avoid in CI
codewhip run "..." --failover     # one switch to the next provider with a stored key on 429 per run
codewhip run "..." --auto-failover # same $0-only chain as --free, but hops are recorded not printed
codewhip run "..." --provider mistral --models mistral-small-latest,mistral-medium-latest,ministral-14b-latest
                                  # walk models in order on 429, each once per run (order: wait, rotate, failover)
```

Waits (`--retry-wait`) are 429-only; moves (same-provider `--models`
rotation, `--failover`/`--free`/`--auto-failover` hops) trigger on
rate-limit, timeout, and upstream 5xx — a slow or struggling model is
better served by another target than by waiting. Auth and other transport
errors never trigger either: retrying them only repeats the failure. `--failover` needs the other provider's key up front (aborts otherwise — it never runs keyless), starts from the provider default (drop `--model`, or lead `--models` with it), and banners because it may bill pay-go. Keep completion-refusers like `codestral-latest` out of agent chains: it answers but won't call tools for file work. Receipts show the per-model mix whenever a run crosses models or providers.

### TUI slash commands

`codewhip run --tui` opts into the terminal UI. The rich renderer needs the
optional peer `@opentui/core` (`npm i @opentui/core`) on a runtime its native
core supports (Bun >=1.3 or Node >=26.4; win32/linux/darwin x64+arm64
prebuilds). Headless stays the default, and every other environment — any OS
without a prebuild, Node < 26.4, no install — falls back automatically to a
readline-safe view that still shows the approval card, transcript tail and
footer. The TUI never breaks a run; `--no-tui` forces 80-col output.

Inside `--tui`, three commands steer the live run without restarting it:

- `/model <provider>[:<model>]` — switch provider/model at the next turn
  boundary (receipts split per model, so the switch stays metered);
- `/free` — show the free chain and which hops are currently usable;
- `/plan` — plan mode is run-scoped, so this only reports that: re-run
  with `--plan` for a read-only run.

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

### Measure it: eval, metrics, verdict

```sh
codewhip eval --free            # 12 fixture tasks, machine-graded, recorded to .codewhip/eval.jsonl
codewhip metrics                # per-class bars: >=70% polish / >=50% implement (MET/NOT MET)
codewhip verdict --auto e029e31f  # propose accepted/edited/reverted from checkpoints vs the tree; records on one keypress
```

`eval` runs the agent against tiny fixture repos in disposable temp dirs
(the checker must fail on the raw fixture and pass on the solved one, or
the task doesn't ship) and merges each run's outcome row into the host
`outcomes.jsonl`. `metrics` reads outcomes + verdicts, so the bars are
measured, not claimed. `verdict --auto` never proposes `rejected` and
refuses non-interactive sessions — the judgment stays human-attached.

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
