# CodeWhip — crack through code like a whip

[![ci](https://github.com/hasitpbhatt/codewhip/actions/workflows/ci.yml/badge.svg)](https://github.com/hasitpbhatt/codewhip/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

> The terminal agent a team lead can let an intern run on prod-adjacent code at
> 2am — policy-checked, memory-scoped, replayable, metered.

An **open, model-agnostic, local-first terminal coding agent**. OpenCode
optimizes for freedom, Claude Code for capability inside a closed box; neither
optimizes for *delegatability* — the moment a senior trusts the tool in a
junior's hands unsupervised. CodeWhip does, and prices every run while it's at
it.

**Status: H1 done (2026-09-17).** `codewhip run` executes a real agent loop:
12 tools, 136 providers, a harness-side policy jail, a hash-chained audit log,
and a cost meter. Not published to npm yet — install from source below.

## Quickstart

From source (works today — the package is not published yet):

```sh
git clone https://github.com/hasitpbhatt/codewhip
cd codewhip && npm install && npm run build
npm link   # optional: puts `codewhip` on PATH; else use `node dist/index.js …`
```

Then, in any repo you want the agent to work on:

```sh
codewhip init                         # 30s: AGENTS.md + codewhip-policy.yaml + signing key
codewhip demo --deny                  # offline: 5 disasters refused. $0, no key, no network
codewhip run "fix the failing test" --free    # keyless first success (free chain, never bills)
codewhip auth login nvidia            # the default provider needs a key (free at build.nvidia.com)
codewhip run "refactor auth" --token-budget 250000
codewhip trust                        # chain, policy, keys, memory state in one command
codewhip audit --verify               # re-walk seq/prev_hash + ed25519 signatures

# in CI: stdout is the data, every banner is on stderr
git diff HEAD~1 | codewhip run -p --output-format json --max-budget-usd 0.10 \
  "review this diff" > review.json
```

`demo --deny` is the whole pitch in 20 seconds and the reason to install it:
watch it refuse `rm -rf`, then prove the refusal is recorded.

Every run prints its receipt — `tokens / model mix / $`. Known $0 routes price
exactly; everything else prints `cost untracked` and points at its provider
console rather than inventing a number. `--token-budget` and `--max-budget-usd`
are both enforced **mid-run**, not as a preflight guess: cross either ceiling and
the run stops, keeps the partial transcript, and prints the receipt anyway. A
dollar ceiling on a route whose price is untracked is refused rather than left
inert — a limit that cannot be measured is not a limit.

## How it works

- **Loop** `prompt → stream LLM → permission check → exec → append → repeat`,
  Ctrl-C safe, `--max-steps 25` hard stop. Twelve tools: `read`, `search`,
  `edit`, `write`, `bash` (real shell), `webfetch`, `todo`, `delegate`,
  `delegate_many`, `run_in_background`, `task_output`, `task_stop`. Git rides
  the bash allowlist rather than being a thirteenth tool. Tool output is capped
  (4000 chars) so one runaway command can't flood the context window.
- **Policy** is harness-side, never in the prompt — **zero tokens per rule**.
  The model is told only "the harness blocks destructive commands", so it can't
  talk its way around rules it has never seen. Defaults: read allow,
  edit/write/shell ask, external denied. A non-overridable denylist plus an
  explicit deny on shell chaining (newlines, `;`, `|`, `&`, backticks, `$()`)
  means a smuggled `git status\nrm -rf .git` is denied, not asked about.
  `--yolo` bypasses `ask` — never the denylist.
- **Memory** is files-first and git-native. `a` at an approval prompt stores a
  *curated shape* in `.codewhip/remembered.jsonl` with provenance. Redirects,
  pipes and chains are never memorable, and `.codewhip/**` plus
  `codewhip-policy.yaml` self-protect. `codewhip remember list` shows what the
  agent is allowed to do without asking; `remember forget` takes it back. No
  vector DB until >500 outcomes prove the need.
- **Audit** `.codewhip/outcomes.jsonl` every run, and append every tool call to
  the hash-chained `.codewhip/audit.log` (`seq/ts/actor/tool/args_hash/
  result_hash/prev_hash/policy/sig`), ed25519-signed with the `init` keypair.
  The log stores **hashes only** — never raw args or output — so redaction at
  write holds by construction. `--verify` re-walks the chain, `--replay`
  renders it, `--export` writes a signed content-addressed bundle.
- **Router** three task classes: implement → nvidia free tier, polish → kilo
  priced $0, private → a local runtime *you* registered. Classification is
  automatic with the reason printed; `--class`/`--provider`/`--model` always
  override. A private prompt routes only to a loopback provider and refuses
  cloud routing unless you name one — informed consent, not a guess.
- **Sandbox** v1 is a Node path jail (realpath, symlink-aware) plus the
  denylist. That is a harness jail, **not OS isolation** — v2 swaps the
  executor (E2B/Firecracker) behind the frozen policy/audit schema.

`run --share` writes a twice-redacted bundle (prompt, per-tool previews, policy
verdicts, receipt) anchored to the audit chain. Local file, no upload, no
server; the "link" is the path plus its content hash.

## What else it does

One line each; the full contract for every item is in
[`docs/features.md`](docs/features.md).

| | |
|---|---|
| `-p` / `--output-format` | scriptable one-shot: `text`, one `json` document, or `stream-json` NDJSON of every tool call, retry and policy verdict |
| `--json-schema` / `--input-format` | the answer must validate (one billed repair round, then a real failure rather than a near-miss) · NDJSON on stdin drives several turns of one session in one process |
| `rollback` | every `edit`/`write` is snapshotted first; one command undoes a run, hash-verified |
| `--plan` | run-scoped read-only mode: above `ask`, above `--yolo`, above memory — nothing can grant a mutation |
| `delegate` | read-only, depth-capped subagents on the same audit chain, folded into the parent receipt |
| `run_in_background` | dev servers and long test suites, with the same guards as `bash` |
| `/commands` | `.codewhip/commands/*.md` prompt templates, expanded before the model sees them |
| hooks | `PreToolUse` can veto; `PostToolUse`/`Stop` observe. Only an assertion denies — a crash warns and proceeds |
| compaction | long runs prune their own oldest tail instead of dying on the context ceiling, with a printed receipt |
| `--continue` / `-r` | opt-in transcript resume, by name or id prefix; `--name`/`--tag`/`--fork-session` label and branch the file; nothing touches disk unless you arm it |
| `serve` | the whole registry behind an OpenAI-compatible HTTP endpoint. It is a proxy: no tools, no policy, no audit |
| `eval` / `metrics` / `verdict` | 12 machine-graded fixture tasks and the bars they feed, so success is measured not claimed |

## Providers

The registry holds **136 builtins**; keys live in an owner-only file (or env,
which wins) and `codewhip auth status` never prints one. `--free` arms the
free-provider chain: on rate-limit, timeout or 5xx it hops, walking only tiers
that **never bill pay-go** — chain membership requires a non-billing tier,
which is why one-time signup credits sit outside it. `--auto-failover` is the
same chain with a quiet terminal.

Full table, key URLs, rate-limit caveats and the reasons providers were
*removed*: [`docs/providers.md`](docs/providers.md). Two that apply to you
whichever provider you pick — free tiers may train on your prompts, and relays
see every prompt in plaintext. Never send private or production code to either.

## Development

```sh
npm run dev        # tsx src/index.ts, no build
npm run typecheck  # tsc --noEmit
npm test           # $0-quota suite: 584 tests, no API key, no network
npm run build      # tsc -> dist/
```

Node >= 22 for development, >= 20 to run the built CLI. Contributor setup,
`npm link`/watch-mode notes, repo map, commit style and the DCO requirement:
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Roadmap

- **H1 (parity + trust)** — done: loop, jail, audit chain, memory, router,
  share, packs, CI action.
- **H2** — sandbox profiles, pack registry with SSO/retention, graph memory
  only on proven pain, auditor bundle v2. Terminal trust compounds first;
  TUI/desktop/IDE after that.
- **The bet** — induce per-repo least-privilege tool permissions from one-bit
  human verdicts, so the thing that compounds is a corpus no lab can download.
  Protocol and results: [`docs/moat/18-verdict-privilege-experiments.md`](docs/moat/18-verdict-privilege-experiments.md).
- **Never (kill list)** — model hosting or training, MCP catalog,
  SQLite/vector DB, subscription that hides the meter, yolo-by-default, public
  launch before the meter proves itself. Full list:
  [`docs/roadmap.md`](docs/roadmap.md).

## Strategy

`SOUL.md` is the project's conscience and wins every design argument. Its
rulings came from a debate between five Naval personas, converged in
[`docs/moat/00-convergence.md`](docs/moat/00-convergence.md) — read it before
proposing a direction change. The personas are local dev tooling (gitignored),
not the product.

## Contributing

Bug reports and feature requests:
[issues](https://github.com/hasitpbhatt/codewhip/issues). Vulnerabilities (jail
escape, audit forgery, redaction leak) go to private email — see
[SECURITY.md](SECURITY.md). MIT — see [LICENSE](LICENSE).
