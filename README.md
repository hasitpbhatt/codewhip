# CodeWhip — crack through code like a whip

> The terminal agent a team lead can let an intern run on prod-adjacent
> code at 2am — policy-checked, memory-scoped, replayable, metered.

CodeWhip is an **open, model-agnostic, local-first terminal coding agent**
(an OpenCode equivalent for the CLI), built around one wedge the incumbents
leave open: **Governance + Trust**. OpenCode optimizes for freedom;
Claude Code optimizes for capability inside a closed box. Neither optimizes
for *delegatability*. CodeWhip does.

**Status: pre-implementation.** The CLI skeleton ships; `codewhip run` is a
stub. The five Naval agents have debated and converged on the full strategy
(`docs/moat/`), and the build order is fixed (`docs/roadmap.md`).

## Why CodeWhip

| Incumbent | Strength | Gap CodeWhip attacks |
|---|---|---|
| OpenCode | Open, 75+ providers, fast shipping | Permissions are a safeguard, not a sandbox; state doesn't compound; no audit/SOC2 story |
| Claude Code | Enterprise trust, workflow revenue | Closed, provider-locked, expensive (~$5/M vs ~$0.12/M routable), harness leaked |
| Cursor-style | Distribution + data flywheel | IDE-bound, telemetry-based, not yours |

The moat ranking we build by: **memory > governance > execution >>
connectors**. Anything that doesn't get more valuable the longer a customer
uses it doesn't ship in H1.

## Quickstart (target UX — not yet implemented)

```sh
npm i -g codewhip
codewhip init        # 30s: AGENTS.md + codewhip-policy.yaml + local signing key
codewhip run "fix the failing test"
codewhip run "refactor auth" --budget 1.00
codewhip audit --last 20        # what did it do?
codewhip audit --verify         # prove the chain is intact
codewhip run "migrate db" --share   # redacted audit link for the PR
```

Every run prints receipts: `tokens / model mix / $`.

## How it works (design)

- **Loop:** `prompt → stream LLM → permission check → exec → append → repeat`,
  Ctrl-C safe, `--max-steps 25` hard stop. Five tools only: `read`, `search`
  (glob+grep), `edit`, `bash`, `git-via-bash`.
- **Policy:** `codewhip-policy.yaml`, LAST-match-wins, fail-closed
  (`read:allow edit:ask shell:ask external:deny`). The harness enforces —
  the model can beg, the harness says no.
- **Audit:** append-only hash-chained JSONL (`.codewhip/audit.log`) with
  secret redaction at write time; `--verify / --replay / --export` produce
  the auditor's bundle (SOC2 CC7/CC8 evidence as files, verifiable offline).
- **Memory:** files-first and git-native — `memory.md` (<100 lines),
  `notes/<path>.md`, `outcomes.jsonl` (accept/edit/revert/reject + tests),
  `policy.md` promoted from 3 consistent rejections. No vector DB until
  >500 outcomes prove the pain.
- **Router:** 3 task classes (implement → frontier, polish → cheap Flash-class
  at ~$0.01–0.04/task, private → local Ollama), `--budget` preflight +
  mid-run downgrade. Target: polish <$0.05, blended <$0.50.
- **Sandbox:** v1 = Node path jail + non-overridable denylist
  (`rm -rf /`, `push --force`, exfil patterns); `--yolo` escapes explicitly,
  logged and bannered. v2 swaps the executor (E2B/Firecracker) behind the
  frozen policy/audit schema.

## Repo map

```
src/index.ts            CLI entry (help works, run = stub)
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

- **H1 (parity + trust):** `agentLoop()` → 5 tools → 3 providers + meter →
  policy jail + denylist → hash-chained audit → outcomes/memory sidecar →
  `init`/`run`/`--share` → 3-class router with <$0.05 polish receipt →
  GitHub Action + 1 starter pack.
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

### Provider key (NVIDIA free tier, persistent)

```sh
codewhip auth login    # hidden prompt, paste once; stored 0600 outside the repo
codewhip auth status   # set (source: env|file) or missing — never prints the key
codewhip auth logout   # deletes the stored key (re-run login to rotate)
codewhip run "Say OK"  # uses NVIDIA_API_KEY env when set, else the stored key
```

Get a free key at `https://build.nvidia.com/settings/api-keys` (~40 req/min, $0). Env wins when set (CI-friendly). The key file lives in `%APPDATA%\codewhip` (Windows) or `~/.config/codewhip` (posix) — filesystem permissions, not encryption; on shared machines prefer the env var.

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
