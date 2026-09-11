# CodeWhip — crack through code like a whip

> The terminal agent a team lead can let an intern run on prod-adjacent
> code at 2am — policy-checked, memory-scoped, replayable, metered.

CodeWhip is an **open, model-agnostic, local-first terminal coding agent**
(an OpenCode equivalent for the CLI), built around one wedge the incumbents
leave open: **Governance + Trust**. OpenCode optimizes for freedom;
Claude Code optimizes for capability inside a closed box. Neither optimizes
for *delegatability*. CodeWhip does.

**Status: MVP loop live.** `codewhip run` runs a real agent loop
(`read/search/edit/write/bash`, policy-checked, metered, replayable);
`init`/`auth`/`models`/`audit` ship; a $0-quota test suite (57 tests) pins the
policy, jail, memory, and loop. The five Naval agents have debated and
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
codewhip auth login mistral        # optional; nvidia can run keyless on its free tier
codewhip run "fix the failing test"
codewhip run "refactor auth" --token-budget 250000
codewhip audit --last 20           # what did it do?
codewhip audit --verify            # hash-chain check (H1: honest WIP stub)
```

Every run prints receipts: `tokens / model mix / $`.
The token budget is **enforced mid-run**, not a preflight fiction — when the
run crosses it, CodeWhip stops, keeps the partial transcript, and prints the
receipt anyway.

## How it works (design)

- **Loop:** `prompt → stream LLM → permission check → exec → append → repeat`,
  Ctrl-C safe, `--max-steps 25` hard stop. Six tools: `read`, `search`
  (glob+grep), `write` (create/overwrite, refuses harness state), `edit`,
  `bash` (real shell), `git-via-bash`. Tool output is capped at transcript
  push (4000 chars) so one runaway command can't flood the context window.
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
  (usageByModel, failovers, per-tool allow/deny + ruleIds), and `audit --last N`
  tails it. Tool output is redacted twice before it can leak: at the model
  boundary (keys/tokens/PEMs/emails → `[redacted]` in the transcript the
  provider sees) and at write time. The hash-chained `audit.log` +
  `--verify/--export` bundle is the Week-3 H1 item — `--verify` already sits
  in the CLI as an honest stub.
- **Router:** 3 task classes (implement → frontier, polish → cheap Flash-class,
  private → local), `--token-budget` enforced mid-run (
  default 250000), same-provider `--models a,b,c` rotation and one-shot
  `--failover`/`--retry-wait` on 429 only. Target: polish <$0.05, blended <$0.50.
- **Sandbox:** v1 = Node path jail (realpath, symlink-aware) + non-overridable
  denylist; v2 swaps the executor (E2B/Firecracker) behind the frozen
  policy/audit schema.

## Repo map

```
src/index.ts            CLI entry (help, run/auth/models/audit)
src/loop.ts             agentLoop(): stream → permission → exec → append, budget
src/policy.ts           harness policy: denylist, chaining-deny, ask/allow defaults
src/remember.ts         curated memorable shapes (no redirects/chains)
src/remember-store.ts   .codewhip/remembered.jsonl (provenance: ts/runId/preview_hash)
src/tools/              read/search/write/edit/bash + jail
src/testkit/            $0 fake ChatPort for the 57-test suite
SOUL.md                 product conscience (read this first)
docs/roadmap.md         the consolidated build order (H1/H2, kill list, metrics)
docs/moat/00-convergence.md   the 7 debate rulings (no ties)
docs/moat/01-leverage.md      minimal loop + router economics
docs/moat/02-memory.md        compounding memory + flywheel
docs/moat/03-governor.md      policy schema + audit + sandbox
docs/moat/04-scout.md         wedge defense + terminal-first GTM
.opencode/agents/naval-*.md   the 5 reusable Naval personas
AGENTS.md               working agreement for coding agents
```

## Roadmap (abridged)

- **H1 (parity + trust):** `agentLoop()` → 6 tools → 3 providers + meter →
  policy jail + denylist + chaining-deny → curated remembered-shape memory
  (provenanced) → hash-chained audit → `init`/`run`/`--share` →
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
npm test           # $0-quota suite: tsx --test src/**/*.test.ts (57 tests)
```

Requires Node >= 18. TypeScript strict, ESM.

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
```

Keys: nvidia free at `https://build.nvidia.com/settings/api-keys` (~40 req/min, $0); mistral at `https://console.mistral.ai` (free mode is evaluation-grade: RPS + tokens/min + tokens/month caps — check Limits); sensenova at `https://token.sensenova.ai`; alibaba at `https://dashscope-intl.aliyun.com`. Env (`NVIDIA_API_KEY`/`MISTRAL_API_KEY`/`SENSENOVA_API_KEY`/`ALIBABA_API_KEY`) wins when set (CI-friendly). Receipts show `tokens / provider:model / cost`; only nvidia is known-$0 — other providers print "cost untracked" pointing at their console. The key file lives in `%APPDATA%\codewhip` (Windows) or `~/.config/codewhip` (posix) — filesystem permissions, not encryption; on shared machines prefer the env var.

### Surviving rate limits (opt-in, off by default)

```sh
codewhip run "..." --retry-wait   # one Retry-After wait (<=60s) on 429 per run; avoid in CI
codewhip run "..." --failover     # one switch to the next provider with a stored key on 429 per run
codewhip run "..." --provider mistral --models mistral-small-latest,mistral-medium-latest,ministral-14b-latest
                                  # walk models in order on 429, each once per run (order: wait, rotate, failover)
```

Both wait and switch are 429-only: auth, 5xx, and timeouts never trigger them. `--failover` needs the other provider's key up front (aborts otherwise — it never runs keyless), starts from the provider default (drop `--model`, or lead `--models` with it), and banners because it may bill pay-go. Keep completion-refusers like `codestral-latest` out of agent chains: it answers but won't call tools for file work. Receipts show the per-model mix whenever a run crosses models or providers.

### Approvals that stick ("always allow")

Every `edit`/`write`/`bash` call that policy asks about prompts:

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
  are exact paths. Future calls with a matching shape auto-allow and the audit
  shows `default:shell:ask+remembered` — visible, attributable, never silent.
- Targets that the harness must protect (`.codewhip/**`, `codewhip-policy.yaml`,
  `remembered.jsonl` itself) refuse `a` outright — the `write` tool and the
  memory both self-protect.
- The denylist and the chaining-deny win over every remembered rule.
  `--yolo` bypasses ask but never the denylist.

**Token cost: exactly zero.** Policy is enforced harness-side in
`src/policy.ts` / `src/remember.ts` — the model never receives the rules, not
even a summary; the system prompt only tells it "the harness blocks destructive
commands". Policy can grow without touching prompt tokens, and the model can't
talk its way around rules it has never seen.

Remove a rule by deleting its line from `.codewhip/remembered.jsonl`
(one JSON object per line; the file is gitignored with the rest of
`.codewhip/`).

## The five Naval agents

This repo ships its strategy team as reusable subagents
(`.opencode/agents/`, restart opencode after pulling):

- **naval-leverage** — minimal loop + routing economics; kills labor-leverage.
- **naval-memory** — compounding memory + data flywheel; files-first.
- **naval-governor** — policy-as-code + audit + sandbox; enforcement, not memos.
- **naval-scout** — uncopyable wedge + terminal-first GTM; non-clone list.
- **naval-synthesizer** — stages the debate, rules with no ties, converges.

## License

MIT.
