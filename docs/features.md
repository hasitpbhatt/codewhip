# Feature reference

Depth behind the README's tour. Each section is the full contract for one
surface; the README carries only what you need on day one.

## Provider keys

```sh
codewhip auth login            # nvidia: hidden prompt, paste once
codewhip auth login mistral    # same for any other id
codewhip auth status           # per provider: set (source: env|file) or missing — never prints keys
codewhip auth logout mistral   # deletes the stored key (re-run login to rotate)
```

The key file lives in `%APPDATA%\codewhip` (Windows) or `~/.config/codewhip`
(posix) — owner-only permissions (0600 POSIX, user-only ACL on Windows,
repaired on every write). That is containment, not encryption: on a shared
machine prefer the env var. Env wins when set, which is what makes CI work.

Per-provider defaults you can name with `--provider`: `nvidia` (kimi-k3, free
tier $0), `mistral` (mistral-small-latest), `sensenova`
(sensenova-6.8-flash-lite), `alibaba` (qwen-plus), `llm7` (works with no key:
anonymous, rate-limited), `tokenharbor` (needs a key, free account works),
`bai` (needs a key, credit billing), `fabryka` (needs a key, free key +
reasoning model). Key requirements and URLs are in
[providers.md](providers.md).

## Custom providers (any OpenAI-compatible endpoint)

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

Registration is validated (`https://` base — or `http://` on **loopback
only** — `UPPER_SNAKE` env var, 5s–120s timeout) and stored keyless in
`custom-providers.json` next to the key file. `--failover`, `--provider`, and
`models` all see customs. Anything not OpenAI-compatible
(`/v1/chat/completions` + Bearer) needs an adapter, not a table row.

You can also add one without the terminal: while `codewhip serve` is running,
open `http://127.0.0.1:8787/auth` — the key manager page carries the same form
(id / base URL / default model / env var, optional paths and timeout under
"optional"). A registered endpoint joins `/v1/models` immediately, and custom
rows get a **remove** button. The API behind it is `POST /auth/_custom` and
`DELETE /auth/_custom/<id>`; validation is the CLI's, so the two paths cannot
disagree.

Loopback `http://` exists for local runtimes (Ollama `:11434`, vLLM `:8000`,
LM Studio `:1234`), where the traffic provably cannot leave the machine. Any
other host over plain `http://` is still refused — that would put your key on
the wire in clear text. A loopback provider gets a placeholder credential,
because every call path refuses an empty key while a local runtime wants none.
These are also what the router's `private` class routes to, so the id must
differ from any builtin: `ollama` is already the *remote* ollama-cloud service,
so use e.g. `ollama-local`.

## Undo: automatic checkpoints + `codewhip rollback`

Every `edit`/`write` is snapshotted before it happens (before-image + sha256
manifest under `.codewhip/checkpoints/<runId>/` — flat JSONL files,
self-protecting: harness state is never checkpointed). Runs that touched files
print `checkpoints: N file(s) snapshotted — undo: codewhip rollback <prefix>`,
and one command restores the pre-run state:

```sh
codewhip rollback --list        # runs with checkpoints
codewhip rollback e029e31f      # restore every file that run touched
```

Rollback verifies every snapshot hash *before* touching a byte (a tampered
checkpoint refuses the whole restore, never half-applies), restores
newest-to-oldest so the earliest content wins, removes files the run created,
and lands on the hash-chained audit trail like everything else. The intern at
2am has an undo.

## Plan before act: `--plan`

```sh
codewhip run "migrate auth to sessions" --plan
```

The run is **read-only**: `edit`/`write`/`bash` are refused by the harness for
the entire run — above `ask`, above `--yolo`, above remembered rules, nothing
can grant them. `read`/`search`/`webfetch` stay allowed, so the agent can
investigate freely; the run's final output is the implementation plan, which
you review, then re-run without `--plan` to execute it. The banner prints
`!! --plan armed` up front and every refusal lands on the audit trail as
`deny:plan:read-only`.

## Task lists

On multi-step work the model keeps a visible checklist with the `todo` tool:
`replace` the full plan up front, `update` statuses as steps finish, `list` to
re-read. The list lives in `.codewhip/todos.json` — harness state, never a
workspace file — so it is allow-by-default (`default:todo:allow`, still
deniable via a promoted `policy.md` rule), redacted at save, and
parent-run-only (children stay read-only).

## Subagents

The model can spawn **read-only subagents** for investigation and
multi-perspective work — `delegate` runs one child, `delegate_many` fans up to
4 out concurrently (the committee pattern: independent perspectives, then
converge).

```sh
codewhip run "review src/loop.ts for bugs"   # the model may delegate to `review`
codewhip run "compare auth approaches"       # or fan out explore/review/plan
```

Three built-ins ship zero-config: `explore` (find and report with file:line
evidence), `review` (adversarial findings, P0–P3), `plan` (ordered
implementation plan). Custom agents live in `.codewhip/agents/<name>.md` —
flat frontmatter (`description` required, optional `model` served on the
parent's port, optional `max_steps` ≤ 25) and the body is the child's system
prompt; a file overrides a same-name built-in.

Why this doesn't dilute the trust model:

- children are **read-only and network-free** (`read`/`search` only —
  edit/write/bash/delegate/webfetch/todo refused pre-ladder; nothing inside a
  child can prompt, mutate, delegate, or reach the network — the parent fetches
  and passes content) and depth-capped: subagents cannot spawn subagents;
- every child tool call lands on the **global hash-chained audit log** under
  the child's own runId, and the child writes its own `outcomes.jsonl` record —
  nothing is a black box;
- child tokens fold into the parent's **receipt** (same buckets, honest `est.`
  marks) — delegation never spends off-book. Budgets are enforced, not just
  metered: the parent's remaining `--token-budget` is **split across entries**
  (85% children, 15% coordination reserve), each child enforcing its share
  live, and folded child spend can still trip the parent's check mid-run;
- children inherit the run's 429 defenses (`--models` rotation,
  `--retry-wait`) so a parallel fan-out on a rate-limited provider rotates
  instead of dying;
- child progress streams into your terminal prefixed `[<agent>]`, and the
  parent sees only the child's final report — its context stays clean.

`--plan` runs cannot delegate (read-only runs spawn no children), and a child's
`delegate` call is refused as `deny:loop:max-depth` even if a rogue model asks
for it.

## Custom slash commands

Your repeated prompts can become one-liners: `.codewhip/commands/<name>.md` is
a prompt template the harness expands **before** the model sees it (zero tokens
for the definition itself). The body becomes the run's prompt with every
`$ARGUMENTS` occurrence replaced by what you typed after the name (no
placeholder → an `ARGUMENTS:` block is appended); flat frontmatter shares the
agent-file grammar (`description` optional, shown in `.help`).
`.codewhip/commands/fix.md`:

```md
---
description: fix a bug with a regression test
---
Investigate and fix: $ARGUMENTS. Add a failing test first.
```

```sh
codewhip run "/fix src/loop.ts repeats denied calls"   # one-shot
codewhip> /fix src/loop.ts repeats denied calls        # REPL; .help lists commands
```

The two surfaces differ on purpose: one-shot `run` expands only on an exact
command-file match — a prompt like `"/api returns 500"` starts with `/` and
must still run verbatim — while in the REPL a leading `/` is unambiguous
intent, so an unknown `/name` prints an error and never reaches the model.
Broken files error in both (silence about a file you wrote would be fiction);
the TUI can't submit commands mid-run (v1 limitation,
[`moat/19-qol-parity.md`](moat/19-qol-parity.md)).

## Hooks: your shell at the harness seams

`.codewhip/hooks.json` (and the user-level `$CODEWHIP_CONFIG_DIR/hooks.json`)
registers shell commands on three seams — **PreToolUse** (can veto one call),
**PostToolUse** (observe the redacted result), **Stop** (observe the run's end):

```json
{ "hooks": [
  { "event": "PreToolUse", "match": "bash", "command": "grep -q 'rm -rf' || exit 2" }
] }
```

Each hook gets the event payload (tool, redacted args, redacted output, runId,
cwd) as JSON on **stdin** plus `CODEWHIP_*` env vars, and has 10 s and 64 KB of
stdout to speak. Only an **assertion** denies: exit 2, or exit 0 printing
`{"decision":"deny","reason":"…"}` — a deny lands on the audit chain as
`deny:hook:pretool` and the tool never executes. Anything else — exit 1, a
crash, a timeout — **warns and proceeds**: an approval you meant to give can
stay human, but the absence of a signal is not a veto. Post and Stop are
observe-only by ruling (a veto after exec has nothing to stop;
block-and-continue is a spend amplifier).

The commands run outside the bash jail **by design** — this is your config,
like a shell profile, not a model request. Containment is structural: hook
files live only in `configDir()`/`.codewhip/` (paths `write` refuses to touch),
and hooks load **once at run start**, so a mid-run injection can never register
or edit one. Children run without hooks in v1.

## Sessions that survive their own context window (compaction)

Long runs die a quiet death: old tool outputs (file dumps, command logs) crowd
the context until the provider refuses the call. CodeWhip compacts instead of
dying. When a call's estimated size (chars/4, printed as `est.` — no fake
tokenizer precision) crosses the ceiling, the *oldest* tail is pruned, never
the working set:

1. old tool outputs are truncated to a 600-char head with a visible
   `…[compacted]` marker;
2. if that isn't enough, whole old exchanges are elided to stubs naming the
   tools they called — assistant + tool responses move as a block, so the
   transcript stays valid.

The system prompt, your original task, and the newest exchanges are never
touched, and every compaction prints an honest receipt:

```
◆ compacted: 2 old tool output(s) truncated, 1 exchange(s) elided (est. 8112 → 5990 tokens)
```

On by default; the API takes `compactTokens: 0` to disable.

## Keeping the conversation going (`--continue`)

```sh
codewhip run "add retries" --continue            # resume the most recent session
codewhip run "add retries" -r 37b0               # resume by unique id prefix (>=4 chars)
codewhip run "add retries" -r auth               # resume by name
codewhip run "one more thing" -r auth --fork-session --name auth-v2   # branch the file
codewhip sessions                                # saved transcripts, newest first
codewhip sessions rename 37b0 auth               # name an existing session
codewhip sessions tag auth wip                   # tag it (repeatable, max 8)
```

`outcomes.jsonl` stores `prompt_hash`, never the raw prompt — so a saved
transcript is **opt-in only**: nothing is written unless `-r`/`--continue` (or
`--name`/`--tag`, which arm it explicitly) is armed
(the banner says `transcript saved on exit (raw prompts on disk)`). Each run
writes one `.codewhip/sessions/<sessionId>.json`
(`{ v: 1, ts, runId, provider, model, messages }` plus optional `lastRunId`,
`name`, `tags`, `parent`; `0600`, secrets redacted at write time, system message
stripped and rebuilt fresh on resume). The saved transcript is the
post-compaction one — exactly what the last provider call saw — and lands on
every exit path (success, error, cancel). The REPL threads one in-memory
transcript across lines and saves once on `.exit`.

**The file name is the session id**, so resuming grows one transcript instead of
chaining files; `--fork-session` is how you start a new file that still says
where it came from. In the REPL the same moves are `.rename`, `.tag`, `.branch`
and `.sessions`.

A name is a lookup key, so it is one word (≤64 chars, not starting with
`-`/`/`/`!`/`.`) and unique — `-r <name>` is meant to be copy-pasted off the
hint line, and `sessions rename` prints that hint with whatever it just named.
Two sessions answering to one name would make `-r auth` a coin flip, so a
collision is refused before the run starts, not after it has spent a transcript
nobody can find again. Tags are looser on purpose: they are only ever displayed.

## Serve every provider as an OpenAI endpoint

```sh
codewhip serve                                  # http://127.0.0.1:8787, defaults to keyless llm7
codewhip serve --port 8787 --provider nvidia
codewhip serve --host 0.0.0.0 --token s3cret    # a non-loopback bind REQUIRES --token
```

`codewhip serve` exposes the whole registry over the OpenAI HTTP contract, so
any OpenAI client — or another agent framework — can use codewhip's providers
without knowing anything about them. This is what lets a client that cannot
speak 1min's schema still use 1min.

Model routing is `"<provider>:<model>"`, split at the **first** colon so model
ids may keep their own (`kilo:cohere/north-mini-code:free`). A bare provider id
means that provider's default model; a bare model id goes to the server's
default provider. `GET /v1/models` lists every provider as
`<provider>:<default-model>`, and `GET /health` needs no auth. A request with
`"model": "auto"` (or a server started with `--provider auto`) hops silently
to the next healthy target on rate-limit/timeout/5xx — at most 3 upstream
attempts, each failure server-logged, the winner named in `serviced_by`. A
pinned `provider:model` never hops: its failure is returned as-is.

`GET /auth` is a small web page (on by default; `--no-auth-ui` disables it)
that sets and clears provider keys and registers custom endpoints from the
browser. It sits behind the same loopback-or-token rule as the rest of the
server.

The client always receives a well-formed OpenAI SSE stream, even when the
upstream is non-streaming — 1min's port never streams, and `--no-stream`
disables SSE globally, so the server synthesizes the deltas from the whole
response rather than leaking which upstream it landed on.

Two things to be clear about. First, this process spends **your keys** on
behalf of whoever can reach the port, so it binds `127.0.0.1` by default and
refuses a non-loopback bind without `--token`. Second, `serve` is a model
proxy, not an agent run: it executes no tools, applies no policy, and writes no
audit entries, because there are no tool calls to record. The client owns tool
execution and therefore owns its own safety story. Provider health is still
recorded in `codewhip stats`.

`GET /stats` (restored 2026-09-16) is aggregated provider/model health only —
the same `summarizeCalls` view auto-routing reads. Per-request history stays
unserved (removed in `d8f784f`), and the bearer gate covers `/stats` the same
way it covers `/playground`.

## Surviving rate limits (opt-in, off by default)

```sh
codewhip run "..." --retry-wait    # one Retry-After wait (<=60s) on 429 per run; avoid in CI
codewhip run "..." --failover      # one switch to the next provider with a stored key on 429 per run
codewhip run "..." --auto-failover # same $0-only chain as --free, but hops are recorded not printed
codewhip run "..." --provider mistral --models mistral-small-latest,mistral-medium-latest,ministral-14b-latest
```

The last form walks models in order on 429, each once per run (order: wait,
rotate, failover).

Waits (`--retry-wait`) are 429-only; moves (same-provider `--models` rotation,
`--failover`/`--free`/`--auto-failover` hops) trigger on rate-limit, timeout,
and upstream 5xx — a slow or struggling model is better served by another
target than by waiting. Auth and other transport errors never trigger either:
retrying them only repeats the failure. `--failover` needs the other
provider's key up front (aborts otherwise — it never runs keyless), starts from
the provider default (drop `--model`, or lead `--models` with it), and banners
because it may bill pay-go. Keep completion-refusers like `codestral-latest`
out of agent chains: it answers but won't call tools for file work. Receipts
show the per-model mix whenever a run crosses models or providers.

## TUI

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
- `/plan` — plan mode is run-scoped, so this only reports that: re-run with
  `--plan` for a read-only run.

## Approvals that stick ("always allow")

Every `edit`/`write`/`bash`/`webfetch` call that policy asks about prompts:

```
allow bash echo 'x' >> TEST.md? [y/N/a]
```

- `y` — allow once. `N` (or anything else) — deny once, model gets told.
- `a` — allow once **and remember the shape** in `.codewhip/remembered.jsonl`
  with provenance (`ts`, `runId`, `preview_hash`). Shapes are **curated**: only
  a short allowlist of heads is memorable (`git status/diff/log/branch`,
  `npm test/run`, `npx tsx/tsc`, `ls`, `cat`, `echo`, …). Redirects, pipes, and
  chains (`;`, `&`, `|`, newlines, `>`, `>>`) are never memorable; a
  `bash:echo *` shape matches `echo x`, never `echo x >> .git/hooks/…`.
  `edit`/`write` shapes are exact paths. `webfetch` shapes are bare https
  origins — one `a` covers every path under the host, never the query string.
  Future calls with a matching shape auto-allow and the audit shows
  `default:shell:ask+remembered` — visible, attributable, never silent.
- Targets the harness must protect (`.codewhip/**`, `codewhip-policy.yaml`,
  `remembered.jsonl` itself) refuse `a` outright — the `write` tool and the
  memory both self-protect.
- The denylist and the chaining-deny win over every remembered rule. `--yolo`
  bypasses ask but never the denylist.

Revoke with the CLI rather than an editor: `codewhip remember list` prints what
the agent auto-runs without asking, `codewhip remember forget` removes a shape.
The file itself is one JSON object per line under `.codewhip/remembered.jsonl`
(gitignored with the rest of `.codewhip/`), so a hand-delete works too and
stays auditable.

## Promotion: declines that become policy

Decline the same shape 3+ times and it becomes a candidate:
`codewhip policy candidates` lists them, `policy approve "<tool:shape>"`
appends a `deny` line to `policy.md`, and from the next run that shape is
refused pre-flight (before any token burns) with rule pointer
`policy.md:deny:<tool>:<shape>`. `policy list` shows what's promoted.
`policy.md` honors only `deny` lines — promotion can refuse, never permit — and
the non-overridable denylist still wins over it.

## Headless: codewhip in a script

```sh
echo "fix the typo in README" | codewhip run -p              # prompt from stdin
git diff HEAD~1 | codewhip run -p "review this diff"         # argv prompt, piped material
codewhip run -p --output-format json "…" > result.json       # one machine document
codewhip run -p --output-format stream-json "…" | while read -r line; do …; done   # NDJSON
codewhip run -p --json-schema-file shape.json "…"           # the answer must validate
printf '{"type":"user","message":{"role":"user","content":"…"}}\n' |
  codewhip run --input-format stream-json --output-format stream-json   # N turns, one process
```

`-p` (long form `--headless`) installs one rule: **stdout is data, stderr is
prose.** Every banner, receipt line and refusal cause moves to stderr, stdout
carries only the answer, and the REPL never opens. `--output-format` implies it
and chooses the shape: `text` (result only — stdout is empty if the run produced
no text), `json` (exactly one document, always — including a run refused before
the loop started), `stream-json` (an `init` line, one line per `LoopEvent`, then
the same `result` document).

The result document is the run's whole account of itself, not just its text:
`subtype` from the loop's stop reason (`success`, `error_max_steps`,
`error_token_budget`, `error_cost_budget`, `error`, `cancelled`), `is_error`,
`run_id`, `usage` totals with a `by_model` breakdown that keeps the `estimated`
flag, `total_cost_usd` (**`null` when any hop is unpriced — never a fake 0**),
`receipt`, `budget`, `failovers`, `waited_ms`, `compacted`, `checkpointed_files`,
`audit_entries_dropped`, `trace` (every tool call with its policy verdict and
subject), plus `polish_gate`/`share`/`session_id` when those are armed.

Because the same fields drive it, `--max-budget-usd` is a real ceiling rather
than a decorative one: the metered cost is re-read after every hop, so a failover
onto an expensive model trips it too. If a hop turns out to be unpriced the run
stops with `error` instead of continuing past a limit it can no longer measure,
and on the never-billing free chain the flag is refused at parse time. Both
`-p` and `--tui` are parse errors — two writers cannot own stdout.

Interactive approvals are off under `-p`: an `ask` is held and denied, so
`--yolo`, a remembered rule or `--plan` has to carry the run. This is the
CI-safe default — a headless agent that invents its own permission is the bug
the audit chain exists to catch.

`--json-schema` (or `--json-schema-file`) makes the answer a machine-checked
artifact instead of a hopeful paragraph: the run must produce exactly one JSON
document satisfying the schema, and the result gains `structured_output` beside
the prose. A miss costs one repair round (`structured_repairs: 1`) — the
validator's own errors are fed back and the model tries again — and an answer
that still fails ends the run as `error` rather than returning an unvalidated
document. The flag enforces a documented subset (`type`, `properties`,
`required`, `additionalProperties`, `items`, `enum`, `const`, length/number/
item bounds, `pattern`) and refuses at parse time a schema naming anything
outside it, so a gate that cannot fire never looks armed. It conflicts with
`--plan`: a plan is prose.

`--input-format stream-json` is the inbound twin: stdin becomes NDJSON
`{"type":"user","message":{…}}` lines and one process runs them as several
turns of one session — each turn's transcript handed to the next, so turn two
remembers turn one. It implies `-p`, requires `--output-format stream-json`
(each turn emits its own `result` line with its own `run_id`; a single json
document would drop the earlier receipts) and reads prompts from stdin only.
Every other line shape is refused by name, including `tool_result` and a forged
`role:"assistant"`, and input is read at turn boundaries — nothing is injected
into a step already running, no line answers a permission prompt, and a turn
that ends badly stops the stream rather than continuing on poisoned history.
`--max-budget-usd` and `--token-budget` move to process scope across the turns,
and the session file is pinned to the first turn: a stream is one transcript.

## Team packs + CI

`codewhip pack list` shows packs shipped with the install; `pack pull starter`
copies the starter `policy.md` (publishing / infra / secret-file denies) into
your repo. Local-file v1 — no registry, no network.

`.github/workflows/ci.yml` runs typecheck + lint + tests + build in one Node 22
job, with separate license, OpenSSF-scorecard and dependency-audit checks.
`actions/run/action.yml` runs the agent headless in CI (ask⇒deny by
construction, never `--yolo`) and uploads `.codewhip/` as the audit artifact.
PR commenting is deliberately unwired in v1 — review the trail first.

## Measuring it: eval, metrics, verdict

```sh
codewhip eval --free              # 12 fixture tasks, machine-graded, recorded to .codewhip/eval.jsonl
codewhip metrics                  # per-class bars: >=70% polish / >=50% implement (MET/NOT MET)
codewhip verdict --auto e029e31f  # propose accepted/edited/reverted from checkpoints vs the tree
```

`eval` runs the agent against tiny fixture repos in disposable temp dirs (the
checker must fail on the raw fixture and pass on the solved one, or the task
doesn't ship) and merges each run's outcome row into the host `outcomes.jsonl`.
`metrics` reads outcomes + verdicts, so the bars are measured, not claimed.
`verdict --auto` records on one keypress, never proposes `rejected`, and
refuses non-interactive sessions — the judgment stays human-attached.
