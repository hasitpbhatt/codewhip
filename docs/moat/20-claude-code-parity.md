# 20 — Claude Code parity: the matrix and the build queue

Goal: close the feature gap between codewhip and Claude Code. This file is the
audit instrument, not an essay: every row is one Claude Code capability, one
status, and file:line evidence on the codewhip side. It replaces
`10-competitive-reality.md` §4 as the gap list (that doc stays as the 2026-09-18
record; several of its "still open" items have since shipped and are marked so
here).

Method: Claude Code's surface was taken from the live docs in September 2026 —
[cli-reference](https://code.claude.com/docs/en/cli-reference),
[commands](https://code.claude.com/docs/en/commands),
[interactive-mode](https://code.claude.com/docs/en/interactive-mode),
[hooks](https://code.claude.com/docs/en/hooks),
[skills](https://code.claude.com/docs/en/skills),
[plugins](https://code.claude.com/docs/en/plugins),
[sub-agents](https://code.claude.com/docs/en/sub-agents),
[mcp](https://code.claude.com/docs/en/mcp),
[headless](https://code.claude.com/docs/en/headless),
[permission-modes](https://code.claude.com/docs/en/permission-modes),
[sandboxing](https://code.claude.com/docs/en/sandboxing),
[tools](https://code.claude.com/docs/en/tools),
[checkpointing](https://code.claude.com/docs/en/checkpointing),
[settings](https://code.claude.com/docs/en/settings),
[memory](https://code.claude.com/docs/en/memory),
[agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript).
codewhip's side was taken from the compiled registry and `src/`, not from docs.

## Legend

| | meaning |
|---|---|
| **HAVE** | codewhip ships it, same or adjacent name |
| **ALIAS** | codewhip ships it under a different name — parity, no work |
| **PARTIAL** | the capability exists but the documented behaviour is incomplete |
| **GAP** | absent. Each GAP carries a wave number: 1 → 5, in build order |
| **N/S** | not in scope for an open, model-agnostic, terminal-only agent (see ruling) |

## Scope ruling — what cannot be a parity row

Claude Code's 2026 surface includes Anthropic-platform capabilities that a
model-agnostic open-source CLI cannot have *as such*: account OAuth to
claude.ai, hosted cloud sessions, the Slack/GitHub-App auto-fixers, Claude
Design, Artifacts browser, mobile QR pairing, Remote Control from claude.ai,
self-hosted runner environments, the native-binary installer, and server-side
`advisor`/`ultrareview` (a paid multi-agent cloud fleet). These are marked
**N/S** — they are distribution of one company's service, not features of a
terminal agent. What *is* in scope is the local equivalent: codewhip's own
`serve`, `--free`, and CI action already cover the "run it headless somewhere
you control" half of that story.

This ruling is additive and changes no frozen schema. The kill list
(`docs/roadmap.md`) is unchanged: no MCP *catalog* or marketplace. MCP **client
support** — consuming someone else's server — is wave 3 and needs its own
recorded ruling when it lands, because it touches the audit boundary.

## A. Invocation and scripting

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `claude "query"` interactive start | HAVE | `src/index.ts:2948` bare `codewhip` on a TTY opens the REPL, `cmdRepl:1781`; a positional query is the first turn of a run (`:1475`) |
| `-p/--print` headless one-shot | HAVE | `-p`/`--headless` (`src/index.ts:676`); `src/run-output.ts` owns stdout, prose moves to stderr. `--print` keeps its older share-markdown meaning — the long name diverges, the short flag does not |
| `cat file \| codewhip -p "query"` stdin piping | HAVE | `readStdin` (`src/run-output.ts:92`): stdin is the prompt when there is no argv prompt (`src/index.ts:2952`), and is appended as context when there is one (`src/index.ts:2971`) |
| `--output-format text\|json\|stream-json` | HAVE | `src/run-output.ts:22` parse, `:161` result document, `:208` emit; NDJSON init/event/result on stream-json |
| `--input-format stream-json` | **HAVE** | `src/stream-input.ts` — `parseUserMessage:47` (one accepted shape; every refusal names what it saw), `inboundMessages:102` (lazy NDJSON generator, 64-message cap); flag at `src/index.ts:686` with the two conflicts at `:713`/`:718`, first message resolved pre-flight at `:1008`, the turn driver at `:1480` (`runTurn:1420`, session pin `:1481`, process-scoped budgets `:1400`) |
| `--json-schema` validated result | **HAVE** | `src/structured.ts` — `parseSchema:34` (subset enforced at the door, names the offending keyword and its path), `validateJson:100`, `extractJson:223`; the gate is in the loop at `src/loop.ts:731` (one billed repair round, then `stopReason: "error"`); flags at `src/index.ts:618`/`:629`, resolved pre-flight at `:1251`; `structured_output` beside the prose at `src/run-output.ts:208` |
| `--max-budget-usd` | HAVE | `src/index.ts:694` parse, `:1447` mid-run `costCheck` over `meteredCost` (`src/router.ts`); refuses an unpriced route rather than going inert (`src/index.ts:1361`) |
| `--max-turns` | ALIAS | `--max-steps 25` |
| `--allowedTools` / `--disallowedTools` | HAVE | `src/tool-filter.ts:46` parse, `:146` match; `src/loop.ts:907` grant inside ask, `:863` refuse above the ladder; `src/index.ts:587`/`:595` (both spellings + `=` form) |
| `--append-system-prompt[-file]`, `--exclude-dynamic-system-prompt-sections` | HAVE | `composeSystemPrompt` (`src/system.ts:55`), called from `src/loop.ts:434`; flags at `src/index.ts:647`/`:655`/`:676`, file read pre-flight at `:1363` |
| `--model` / `--fallback-model` | HAVE | `--model`, `--models`, `--failover`, `--free` |
| `--effort low…max` | **GAP-3** | no thinking-budget control |
| `--permission-mode` 7 modes | **HAVE** | six modes shipped (`default`/`acceptEdits`/`plan`/`bypassPermissions`/`dontAsk`/`manual`) — set at `src/settings.ts:21`, exact-match parse `:32`, flag parse `src/index.ts:613`, precedence `:1208`, ladder rungs `src/loop.ts:951`–`:1020`. The 7th (`auto`) is the classifier row below, not counted twice. Before Wave 2c this row was `--plan` + `--yolo` only |
| `--add-dir` multi-root | **HAVE** | `src/tools/jail.ts:23` `resolveRoots` (existence + realpath + `MAX_ROOTS:5`), `:76` read and `:104` write containment over all roots; flag parse `src/index.ts:625`, validation before the run `:1209`; `src/checkpoints.ts:65` admits an out-of-cwd target so `rollback` can undo it; threaded through `src/tools/types.ts:82` → read/edit/write/search → `src/subagents.ts:604`. Was a single-cwd jail before Wave 2c |
| `--bare` (skip discovery of hooks/skills/commands) | **GAP-4** | absent |
| `--debug`, `--debug-file` | **HAVE** | both arms exist and neither is a verbosity dial on the transcript: they capture the decisions the loop makes and never prints. `--debug` writes to the prose channel (so `-p` keeps stdout as data), `--debug-file <path>` appends to a file (`src/index.ts:592`, `:594`). The sink owns the rules so no call site can forget them: every line is redacted before it lands (`src/debug.ts:120`), an `*.env*` target and any path inside `.codewhip/` are refused because that is where the audit chain, keys and policy this log describes live (`src/debug.ts:41`), and at 8 MiB — or any write error — it warns once and goes quiet, since a broken diagnostic must never kill the run it is explaining (`src/debug.ts:88`). Lines append synchronously: the tail of the run that crashed is the only part anyone reads (`src/debug.ts:104`). 16 sentences sit in the loop, led by the rung that answered a call (`src/loop.ts:1140`) and per-call exec timing with the audit seq (`src/loop.ts:1273`); subagents inherit the parent's sink, because the surprise usually hides in the child (`src/subagents.ts:602`) |
| `--ax-screen-reader` / 80-col safe output | ALIAS | `--no-tui` |
| `--betas` API beta headers | **GAP-3** | wire sends none (`src/provider.ts`) |
| `claude update`, `install [version]` | **GAP-4** | no update path |
| `claude doctor` (read-only diagnostics) | PARTIAL | `codewhip trust` covers chain/policy/keys/memory, not installation |
| `claude setup-token` (long-lived CI token) | **GAP-4** | env keys only |
| `claude gateway` (self-hosted gateway) | ALIAS | `codewhip serve` |
| `claude import` from other agents | **GAP-5** | absent |
| `claude logs`/`attach`/`respawn`/`stop`/`rm`/`daemon` — background session supervisor | **GAP-3** | `run_in_background` jails *commands* (`src/tools/background-tasks.ts`); no detachable *agent session* |
| `--bg/--background` session start | **GAP-3** | absent |
| `--no-session-persistence`, `persistSession` | ALIAS | sessions are opt-in by default (`--continue`) |
| `--from-pr`, `--teleport`, `--cloud`, `--remote-control`, `--environment`, `--ide`, `--chrome`, `--channels` | N/S | platform distribution, not agent capability |

## B. Session and context

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `-c/--continue` most-recent | HAVE | `--continue` |
| `-r <id-or-name>` resume by name | HAVE | `-r`/`--resume`/`--continue` all take a name or a ≥4-char id prefix — `src/sessions.ts:199` (`resolveSession`), `src/sessions.ts:217` (`loadSession`) |
| `--name` / `--fork-session` / `/branch` | HAVE | `--name` + `--fork-session` at `src/index.ts:659`/`src/index.ts:674`, identity decided by `sessionIdentity` (`src/sessions.ts:187`); `.branch` in the REPL at `src/index.ts:1737` |
| `/rename`, `/tag`, `tagSession()` | HAVE | `codewhip sessions rename\|tag` (`src/index.ts:1654`) over `labelSession` (`src/sessions.ts:263`); REPL `.rename`/`.tag` at `src/index.ts:1715` |
| `/clear [name]`, `/compact [instructions]` | PARTIAL | compaction is automatic and model-aware (`src/compact.ts`); no manual `/compact`, no instructions arg |
| `--autocompact auto\|tokens` | ALIAS | `compactTokens: 0` to disable |
| `/context`, `/usage`, `/cost` | HAVE | `.context`/`.usage`/`.cost` in the REPL (`src/index.ts:1896`/`:1904`/`:1906`, dispatched by the same matcher as the session verbs at `src/index.ts:1888`) over a session ledger folded once per run (`src/index.ts:1718`, `src/session-ledger.ts:35`); the grid's fixed costs come from the loop's own report (`src/loop.ts:1334`), not a caller's re-estimate |
| `/export [file]`, `/copy`, `/recap` | PARTIAL | `--share` + `--print` bundle exists; no transcript export/recap |
| `/diff` working-tree view | PARTIAL | `captureBefore` preview + TUI diff (`src/tui/view.ts:54`) |
| `/todos`, `Ctrl+T` checklist | ALIAS | `todo` tool + `.codewhip/todos.json` |
| `/btw` side question outside context | **GAP-5** | absent |
| `/think`, `Option+T`, `ultrathink`, `MAX_THINKING_TOKENS` | **GAP-3** | absent |
| `/statusline`, `/theme`, `/color`, `/keybindings` | **GAP-5** | TUI is deliberately thin (`moat/05-tui-spike.md`); revisit only if the surface survives |
| Vim mode, readline keyset, `Ctrl+G` $EDITOR, `Ctrl+R` history | **GAP-5** | readline defaults only |
| `!` shell mode, `#` memory shortcut, `@`path completion, `:` emoji, `?` panel | **GAP-4** | custom `/commands` exist; these are REPL affordances |
| `/loop`, `/goal`, CronCreate/ScheduleWakeup | **GAP-5** | no recurring run |
| `/batch`, `Workflow`, `Monitor` | **GAP-5** | `delegate_many` is the only fan-out |
| `/sessions`, `listSessions()` | ALIAS | `codewhip sessions` |

## C. Permissions, policy, audit

| Claude Code | Status | codewhip evidence |
|---|---|---|
| allow/deny/ask rules in settings | HAVE | `policy.md`, `codewhip-policy.yaml`, `src/policy.ts` |
| `permissions.defaultMode` | **HAVE** | `src/settings.ts:56` `mergeFile` reads `defaultMode` (`:85`) and its twin `additionalDirectories` (`:95`), reporting and ignoring a bad value; `:117` `loadSettings` layers user then project, project wins; consumed once at `src/index.ts:1053` |
| `EnterPlanMode`/`ExitPlanMode` approval flow | PARTIAL | `--plan` is run-scoped, not mid-run enter/exit |
| Auto mode + classifier rules | PARTIAL → **GAP-3** | the C3 verdict-induction research *is* this, but it is not wired as a runtime mode |
| `/fewer-permission-prompts` (scan transcripts → allowlist) | ALIAS | `policy candidates` / `policy approve` from declines |
| Sandboxing: Seatbelt / bubblewrap, `allowedDomains`, `proxy` | **GAP-4** | harness jail only; honest label ("harness jail, not OS isolation"). H2 item |
| OS-level credential/env scrubbing | PARTIAL | `src/redact.ts` at write + model boundary |
| Audit trail, hash chain, signed export | **HAVE-plus** | `src/audit.ts` — Claude Code has no user-verifiable chain |

## D. Tools

| Claude Code | Status | codewhip evidence |
|---|---|---|
| Read / Write / Edit | HAVE | `src/tools/{read,write,edit}.ts` |
| Glob + Grep | ALIAS | single `search` (glob+grep merged) |
| Bash / PowerShell | PARTIAL | `bash` via powershell on win32; chaining denied by design |
| NotebookEdit | **GAP-4** | absent |
| WebFetch / WebSearch | PARTIAL | `webfetch` exists; **no web search tool** |
| Task/TodoWrite | ALIAS | `todo` |
| TaskCreate/Get/List/Update | **HAVE** | per-item tasks whose edges gate claiming: `todo` list/get/replace/update (`src/tools/todo.ts:71`, `:62`), items carry `description`/`activeForm`/`owner`/`blocks`/`blockedBy`, either edge direction stored both ways (`src/tools/todo-store.ts:146`), a dangling edge (`:129`), a cycle (`:131`) and a claim past an open edge (`:133`) all refused — and re-checked on every write, so the file's invariants hold rather than the argument's (`src/tools/todo.ts:47`) |
| Agent/`Skill` tool | PARTIAL | `delegate`, `delegate_many`; no model-invoked skills |
| AskUserQuestion | PARTIAL | `ask_user`: one question per call (not up to four), no `header`/`preview` field, and a numbered readline rather than a selection widget — `src/tools/ask-user.ts:82`, rendered at `src/index.ts:968`; allow-class at `src/policy.ts:430`, refused for a child at `src/loop.ts:884`, advertised only where a keyboard is reachable (`src/tools/registry.ts:316`) |
| ToolSearch / WaitForMcpServers | **GAP-3** | absent (MCP) |
| EnterWorktree/ExitWorktree, `isolation: worktree` | **GAP-3** | absent; worktree *escape* is denied today |
| LSP tool | **GAP-5** | absent |
| CronCreate/List/Delete, RemoteTrigger, PushNotification, SendUserFile, EndConversation, ReportFindings, Artifact | N/S | cloud/push platform surface |
| Image input to Read | **GAP-3** | `LoopMsg.content` is `string` (`src/provider-port.ts:18`); `read` refuses binary (`src/tools/read.ts:68`) |
| Parallel tool execution | **GAP-3** | `src/loop.ts:801` sequential `for`; deferred in `torvalds-architecture-review.md:105` |
| Prompt caching | **GAP-3** | no `cache_control` anywhere in `src/` |

## E. Subagents and delegation

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `.claude/agents/*.md` + frontmatter | PARTIAL | `.codewhip/agents/<name>.md` (not `.claude/`), flat frontmatter: `description`, `model`, `max_steps`, `tools`, `disallowedTools` (`src/subagents.ts:344`) |
| `tools`, `disallowedTools`, `permissionMode`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation` frontmatter | PARTIAL | `tools` narrows a child's advertised set narrow-only (`src/subagents.ts:144` → `src/tools/registry.ts:301`), `disallowedTools` reuses the run-filter grammar (`src/subagents.ts:386`), and both are compiled onto one list the child is born with (`src/subagents.ts:480`, `:599`); the other eight are refused BY NAME with their reason (`src/subagents.ts:73`) — no field is ever accepted-and-dropped |
| `--agents` JSON, `--agent` | PARTIAL | `--agents '{"<name>":{"description":…,"prompt":…}}'` is the same roster in JSON (`src/subagents.ts:209`) and outranks `.codewhip/agents/*.md`, which outranks the built-ins (`src/subagents.ts:424`, `src/loop.ts:426`); `--agent <name>` puts an entry on the main thread (`src/index.ts:1145` → `src/subagents.ts:522`). Three deltas: the prompt is appended, never a replacement for the harness base; a `tools` narrowing on the main thread can only refuse read/search (`src/subagents.ts:480`); and there is no mid-session agent switch |
| Built-in Explore / Plan / general-purpose | ALIAS | `explore`, `review`, `plan` |
| Agent view panel, parallel background agents, `SendMessage`, teammates | **GAP-3** | children are synchronous and depth-capped |
| Subagent on global audit chain, budget split, folded receipts | **HAVE-plus** | `src/tools/child-run.ts` |

## F. Hooks

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `PreToolUse` / `PostToolUse` / `Stop` | HAVE | `src/hooks.ts` |
| `SessionStart`, `Setup`, `UserPromptSubmit`, `Notification`, `PreCompact`/`PostCompact`, `SubagentStart`/`Stop`, `TaskCreated`/`Completed`, `PermissionRequest`/`Denied`, `SessionEnd`, `FileChanged`, `ConfigChange`, `CwdChanged`, `WorktreeCreate`/`Remove`, `InstructionsLoaded`, `Elicitation`, `MessageDisplay`, `StopFailure`, `TeammateIdle`, `PostToolBatch`, `UserPromptExpansion` — 30 more events | **GAP-3** | 3 of 33 exist |
| `matcher` regex + `if` permission-rule syntax | PARTIAL | `match` is a bare tool name |
| `additionalContext`, `updatedInput`, `systemMessage`, `continue`, `async`, `once`, `statusMessage`, `asyncRewake` | **PARTIAL** | Four ship: `additionalContext` joins the tool result the model reads next (`src/loop.ts:1203` → `:1279`, and `:1311` after exec; capped at 8 000 by `src/hooks.ts:79`), `systemMessage` reaches the human and never a provider (`src/loop.ts:1202`), `continue:false` stops the run (`src/loop.ts:1209` → `StopReason` `"hook"` at `:265`, `src/run-output.ts:158`), and all three are redacted at the same seam that covers a deny reason (`src/hooks.ts:322`). Two are refused BY RULING: `updatedInput` and a non-`deny` `permissionDecision` — PreToolUse fires after the ladder graded the call, so a hook that rewrote its arguments or granted it would run something nobody approved (`src/hooks.ts:224`, `:259`, `:262`). Four are absent: `async`, `once`, `statusMessage`, `asyncRewake` |
| `type: http \| mcp_tool \| prompt \| agent` | **GAP-4** | `command` only |
| Hooks on the audit chain | **HAVE-plus** | `deny:hook:pretool` |

## G. Extensibility: commands, skills, plugins, MCP

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `.claude/commands/*.md` + `$ARGUMENTS` | HAVE | `.codewhip/commands/*.md` |
| `` !`cmd` `` pre-execution, `@file` refs in commands | **GAP-4** | absent |
| Skills: `SKILL.md`, `when_to_use`, model-initiated, progressive disclosure, `/skills` | **GAP-4** | custom commands are prompt expansion only |
| Plugins + marketplaces (`plugin.json`, `marketplace.json`, install/enable) | **GAP-5** | `pack` is a policy bundle, not a plugin |
| MCP client: stdio/SSE/HTTP/ws, `claude mcp add`, scopes local/project/user | **GAP-3** | zero MCP in `src/` — needs a kill-list ruling |
| MCP OAuth (`mcp login/logout`) | **GAP-3** | absent |
| MCP resources/prompts as tools and slash commands | **GAP-3** | absent |
| `mcp__server__tool` namespacing into the permission layer | **GAP-3** | must be designed with policy, not bolted on |
| `allowedMcpServers` / deny lists (enterprise control) | **GAP-3** | same ruling |
| Agent SDK (TS/Python `query()`, `canUseTool`, custom tools) | PARTIAL → **GAP-2** → **HAVE** · Python ALIAS | `src/sdk.ts:480` `query()`, `:161` `tool()`, `:319` `askUserFor` (`canUseTool` on the ask rung); gates resolved at `:217` before any call. Python drives the same engine over NDJSON (`--input-format`/`--output-format stream-json`), without an in-process decider |

## H. Memory and project files

| Claude Code | Status | codewhip evidence |
|---|---|---|
| CLAUDE.md hierarchy enterprise/project/user | PARTIAL | `AGENTS.md` + `policy.md`; no user-level or enterprise tier (`src/system.ts`) |
| `@path` imports, `.claude/rules/` with `paths:` | **GAP-4** | no imports; `docs/moat/02-memory.md` planned it |
| auto memory dir per project, `/memory` | PARTIAL | `src/remember.ts` + `remember-store.ts`; no `/memory` view |
| `claudeMdExcludes`, `instructionFiles` | **GAP-4** | fixed filename |
| Always-allow memory with provenance + curated shapes | **HAVE-plus** | `src/remember-store.ts` — Claude Code stores no provenance |
| Policy promotion from repeated declines | **HAVE-plus** | `src/policy-store.ts` |

## I. Checkpointing and undo

| Claude Code | Status | codewhip evidence |
|---|---|---|
| per-turn checkpoint, `/rewind`, Esc+Esc | PARTIAL | per-run, per-file (`src/checkpoints.ts`); no per-turn granularity or picker |
| Restore code / conversation / both, summarize-from-here | **GAP-4** | `rollback` restores code only, never the transcript |
| retention + cleanup policy (`cleanupPeriodDays`) | **GAP-4** | no pruning |

## J. Observability, metrics, research surface

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `/insights` session report, `sessionStore` | **GAP-5** | absent |
| usage/limit telemetry, `system/api_retry` events | PARTIAL | `src/provider-stats.ts` + `codewhip stats` |
| Task success bars, machine-graded eval, verdicts, trust certificate, signed audit, cost receipts | **HAVE-plus** | `src/eval.ts`, `src/metrics.ts`, `src/verdict.ts`, `src/trust` path — Claude Code has no equivalent; this is the wedge |
| Escape/autoimmune suite (`npm run immunity`) | **HAVE-plus** | `src/immunity/` |

## Score

Counted by `npm run parity` (`scripts/parity.mjs`), which parses the status
column of every row above and fails if this section no longer matches them:
**102 in-scope rows** — **HAVE/ALIAS/HAVE-plus 43**, **PARTIAL 19**, **GAP 40**,
i.e. **42.2%** at parity or better. Remaining GAP rows by wave: 3 → 18, 4 → 13,
5 → 9. Wave 2 is closed.

Two corrections, recorded rather than made silently (2026-09-24, at Wave 1
close):

- The first version of this section was hand-counted as 34 / 22 / 62 ≈ 46%. It
  counted 16 rows that are not capability rows — the per-section header and
  separator lines and the legend table — and so overstated both the denominator
  and the HAVE column. Every number here is now produced by parsing the status
  column of this file, not by eye.
- The lower number also supersedes `10-competitive-reality.md:14` ("40–50% by
  count", 2026-09-18). That figure was an eyeballed estimate with no row list
  behind it, and row-level counting is stricter than category-level impression:
  it also catches overstatement, since that doc placed "headless/CI usage"
  *at or above parity* when in fact nothing about `codewhip run` could be
  scripted — no `-p`, no machine-readable output, piped stdin was a usage
  error. Wave 1 is what makes that line true. Where the two docs still agree is
  the shape: ahead on governance, audit, receipts and delegation hygiene;
  behind on model steering, extensibility (hooks/MCP/skills), vision and git
  workflow integration.

Wave 1 (headless scripting) closed 4 rows: `-p/--print`, stdin piping,
`--output-format`, `--max-budget-usd`. HAVE-or-better went 25 → 29, GAP 61 → 57.

Wave 2a (session naming) closed 3 rows: resume by name, `--name`/
`--fork-session`/`.branch`, `sessions rename|tag` + REPL `.rename`/`.tag`.
HAVE-or-better 29 → 32, GAP 57 → 54. Two things this deliberately did *not*
copy from Claude Code: names are one word with no spaces (a name is the handle
`-r` looks up, and a two-word name prints a resume command that does not
resume), and a name collision is refused before the run starts rather than
after it has spent a transcript nobody can find by name again.

Wave 2b (request shaping) closed 2 rows: `--allowed-tools`/`--disallowed-tools`
(and the camelCase spellings) and the system-prompt surface
(`--append-system-prompt`, `-file`, `--exclude-dynamic-system-prompt-sections`).
HAVE-or-better 32 → 34, GAP 54 → 52. Three rulings inside it:

- **Filters reuse the remembered-rule shape grammar, not a new one.** One
  language for shapes (`bash(git status *)`, exact path, one https origin) with
  three consumers — persistent rules, promoted policy denies, session filters.
  What differs is authority, not syntax: a stored shape is curated at keystroke
  time because one `a` must not generalize freely, while a pattern typed on the
  command line names any head. `--yolo` proves that authority class and is
  broader than it.
- **Position in the ladder is the whole feature.** `--disallowed-tools` refuses
  *above* the ladder (with `--plan`), `--allowed-tools` answers an ask *inside*
  it, so neither can touch a policy deny and the allow cannot touch plan mode.
  An allow is consulted before `--yolo` so the audit line says which flag
  granted it, and a grant never covers a self-protected path. On a conflict
  between the two lists the disallow wins.
- **`--exclude-dynamic-system-prompt-sections` drops advertising, never
  refusals.** The delegable-agent roster is a per-run token cost; the plan-mode
  note states what the harness will refuse, and a prompt that hides a refusal
  produces a model that retries it.

Also verified against the real binary rather than only in tests: with
`--allowed-tools "write(notes.md)"` a headless run writes the file and prints
`▸ ok write notes.md (default:write:ask+allowed-tools)`; without the flag the
same call prints `▸ held write notes.md (default:write:ask)` and writes nothing.

Wave 2c (permission modes, extra roots, default mode) closed 3 rows:
`--permission-mode`, `--add-dir`, `permissions.defaultMode`. HAVE-or-better
34 → 37, GAP 52 → 49; the wave-2 remainder at that point was 3 rows
(`--input-format stream-json`, `--json-schema`, programmatic entry). 28 new
tests in `src/permission-mode.test.ts`, all 669 pre-existing tests untouched.
Five rulings inside it:

- **A mode chooses who answers an ask. It never outranks a deny.** The ladder
  keeps its order — non-overridable denylist and structural refusals, then
  `--disallowed-tools`, then policy, then the mode, then the prompt — so
  `bypassPermissions` answers asks and nothing else. `src/permission-mode.test.ts:338`
  asserts it in the test that matters: with mode *and* `--yolo` *and* an
  allowed-tools match, a `rm -rf` still dies on `deny:denylist:`. `manual` is the
  mirror image: it is the only rung that can be *overridden by nothing*, not
  `--allowed-tools` (`src/loop.ts:907`), not a remembered rule (`:974`), not
  `--yolo`, because an operator who says "ask me" has already answered the
  question the other flags would answer.
- **Six modes, not seven.** `auto` is deliberately absent: it names a
  classifier, and shipping the word without the judgement behind it would add
  a label that behaves like `acceptEdits` and advertises something else. It is
  the §C classifier row, which stays GAP-3.
- **`plan` is structural, not a permission.** `--plan` outranks `--yolo` and
  `--allowed-tools` (creed, `docs/moat/00-convergence.md`), so a mode string
  cannot un-plan a run either: `src/loop.ts:383` ORs the two sources and the
  read-only refusal fires from `planMode`, above every grant.
- **A wider jail is still only a jail.** `--add-dir` roots are realpath'd,
  existence-checked, capped at 16 and reported when dropped
  (`src/tools/jail.ts:23`); inside them the secret denylist and `.codewhip/`
  self-protection still bite, because containment and authority are different
  questions. `dontAsk` denies rather than answering — an ask that quietly
  disappears is a silent failure; the audit line says
  `+mode:dontAsk` with actor `policy`, so a run that did nothing is
  distinguishable from a run that refused.
- **Every grant says which flag granted it.** `+mode:bypassPermissions`,
  `+mode:acceptEdits`, `+yolo` and `+allowed-tools` are distinct `ruleId`
  suffixes on the same verdict, so the audit can answer "was this written
  because of a flag or a rule?" without a schema change. `AuditActor` stays
  the frozen four (`policy|human|remembered|yolo`) and `POLICY_VERSION` stays
  `v1-2026-09-18`: `checkPermission` returns the same verdicts it always did,
  so there was nothing to re-rule. The outcome record gained one additive
  field, `permission_mode` (`src/outcomes.ts`), on the `task_class` precedent —
  readers treat absence as unknown, never as `default`.

Widening the jail exposed a real bug in the undo path, caught by the new test
rather than by reading: `rollbackRun` refused any manifest entry whose path
escaped cwd, which made `--add-dir` un-rollback-able — a file created outside
the workspace with full authorization and no way back. The guard now checks
protection by absolute path instead of by `..`
(`src/checkpoints.ts:173`), which keeps the wall against a hand-edited
manifest and admits the roots the run was given. `captureBefore` gained the
same roots (`:65`), so out-of-cwd targets are checkpointed like in-cwd ones.

Also verified against the real binary: `--permission-mode=acceptEdits` prints
`!! --permission-mode=acceptEdits armed:` and then
`▸ ok write notes.md (default:write:ask+mode:acceptEdits)` with no prompt; a
`.codewhip/settings.json` with `permissions.defaultMode: "dontAsk"` prints
`!! permissions.defaultMode=dontAsk armed:` and `▸ deny write dont.md
(mode:dontAsk)`; `--add-dir <dir>` prints `!! jail widened:` and the init
document carries `"permission_mode":"dontAsk"` and
`"additional_directories":[…]`. The jail itself was checked against `dist/`
rather than a shell, because Git-Bash rewrites POSIX paths in argv before the
process sees them: the same absolute target reads `1: content from the extra
dir` with the root and `read: path escapes workspace jail` without it.

Wave 2d (validated output) closed 1 row: `--json-schema`. HAVE-or-better
37 → 38, GAP 49 → 48; the wave-2 remainder at that point was 2 rows (`--input-format
stream-json`, programmatic entry). 41 new tests in `src/structured.test.ts`,
all 697 pre-existing tests untouched. Five rulings inside it:

- **A gate that cannot fire must not look armed.** `--json-schema` enforces a
  *documented subset* — `type`, `properties`, `required`, `additionalProperties`,
  `items`, `enum`, `const`, `min`/`maxLength`, `pattern`, `min`/`max(Exclusive)imum`,
  `min`/`maxItems` — and a schema naming anything else (`$ref`, `allOf`, `anyOf`,
  `oneOf`, `not`, `if`, `format`, or a typo like `tipe`) is refused before the
  run starts, naming the keyword and its path (`src/structured.ts:50`, checked
  at `parseSchema:34`). The alternative — accept the document and ignore the
  half of it that is hard — is worse than no flag, because the caller writes
  `jq` against a contract nothing enforced.
- **`integer` is a number, not the other way round**
  (`src/structured.ts:86`/`:92`): a whole number satisfies `number`, a fraction
  never satisfies `integer`. This is the one place where being laxer than the
  letter of JSON Schema is the correct reading, and it is asserted rather than
  implied.
- **"I could not check it" is an error, not a pass.** `pattern` is only
  evaluated against input under `MAX_PATTERN_INPUT` (16 KiB); over that the
  validator reports the check it skipped (`src/structured.ts:18`) instead of
  silently approving — same principle as the subset refusal, one scale down.
- **The repair round is a real billed turn.** A miss pushes a `user` message
  asking for the document again and `continue`s the existing step loop
  (`src/loop.ts:731`, `MAX_REPAIRS = 1`), so `num_turns`, `steps`, token usage
  and the cost receipt all show the extra spend — the metering path is not
  bypassed to make validation look free. An answer that still fails ends the
  run with `stopReason: "error"`: a wrong-shaped document is reported as a
  failure, never as a result.
- **Validation adds beside, never instead.** `structured_output` sits next to
  `result` (`src/run-output.ts:208`, plus `structured_errors` /
  `structured_repairs`), the prose answer is preserved, and in `-p` mode the
  repair chatter is an event on stderr while stdout stays a single machine
  document. Text mode prints the validated document — that is what the flag
  was asked for — but the raw prose remains recoverable from the json envelope.

`--plan` and `--json-schema` conflict is refused pre-flight
(`src/index.ts:1239`): a plan is prose, and arming both would spend tokens
producing a document the run has already decided not to act on. Resolved
before any request goes out (`:1251`), unreadable `--json-schema-file` bails
the same way, and the schema's size is reported in the init document as
`json_schema_chars` (`:1378`) so a caller can see what it paid to enforce.

Also verified against the real binary: asking for `{name, year}` with a schema
requiring a `pattern` on `name` printed `!! --json-schema armed:…`, then
`◈ structured answer rejected (2 problem(s)) — asking for a repair, attempt
1/1`, then `{"name":"Windows","year":1985}` on stdout, with
`receipt: 4494 prompt + 48 completion tokens / llm7:default` — two turns,
charged as two turns.

Wave 2e (inbound scripting) closed 1 row: `--input-format stream-json`.
HAVE-or-better 38 → 39, GAP 48 → 47, and one row is left in wave 2 (the Agent
SDK). 33 new tests in `src/stream-input.test.ts`, all 738 pre-existing tests
untouched. Five rulings inside it:

- **One shape is accepted and everything else is refused by name.** A line must
  be `{"type":"user","message":{"role":"user","content": … }}`; a non-text block
  (`image`), an empty content, a bad JSON line each report what they saw
  (`src/stream-input.ts:47`). Skipping an unparseable line is the alternative,
  and it loses an instruction without saying so.
- **A forged model turn is refused because it rewrites history.**
  `role:"assistant"` on the pipe would assert what the agent already said — the
  one input that is not operator material (`parseUserMessage` refuses it for
  exactly that reason). `type:"assistant"` at the envelope is refused the same
  way.
- **Laziness is the feature, and so is its limit.** `inboundMessages` is an
  async generator (`src/stream-input.ts:102`), so a message written while the
  model is working is picked up when the turn ends — 64 messages per process,
  and a refusal ends the input rather than killing the turn in hand. What that
  deliberately is not: mid-step steering. `tool_result` and
  `control_response` have no inbound path, so the flag says so at the door
  instead of advertising the control protocol; no line answers a permission
  prompt either, and asks stay held and denied as under any `-p` run.
- **N turns cannot spend N times the cap.** `agentLoop` is untouched — each
  turn is an ordinary run whose transcript is fed back as `history`
  (`src/index.ts:1515`), which keeps step budgets, the policy ladder and
  per-run audit records meaningful. What moves to process scope is the metering
  (`src/index.ts:1400`): `--max-budget-usd` is checked against the turns
  already spent, and each turn's `--token-budget` is what remains — while the
  `result` envelope keeps reporting the configured ceiling, not the residual.
- **One session, one result line per turn.** A turn is not merged into a bigger
  document: each finished turn emits its own `result` with its own `run_id`
  and receipt, and the session file is pinned to the first turn
  (`src/index.ts:1481`) so a stream accumulates into one transcript instead of
  one file per message. Requiring `--output-format stream-json` is the same
  claim from the other side — one `json` document for N turns would have to
  drop N-1 receipts.

Also verified against the real binary (`pollinations:openai-fast`, three
messages pushed seconds apart, `--max-steps 2`): three `result` lines with
three distinct `run_id`s answering `four`, `six`, `eight` — the third arrived
as a content-block array — with per-turn receipts `1494+45`, `1518+31`,
`1543+33` and `turns: 3 user message(s) ran as one session (61acfb9c) — 4664
tokens total`. Memory across the boundary was checked directly rather than
assumed: *remember the word mango* then *what word did I ask you to remember?*
answered `mango`, both lines carried the same `session_id` while `run_id`
differed, and the saved file holds four messages, `user,assistant,user,assistant`.
Two negative paths, same run: a forged `{"type":"assistant",…}` printed
`… type "assistant" is not accepted … — queued input dropped` and the turn in
hand still reported normally; a provider 502 on turn 1 printed
`codewhip: turn 1 ended as error — the rest of stdin is not read` instead of
billing the rest of the queue.

Wave 2f (the programmatic entry) closed the last row of wave 2: `query()`,
`tool()`, `canUseTool`. HAVE-or-better 39 → 40, GAP 47 → 46, wave 2 → 0. 11 new
tests in `src/sdk.test.ts`, and `src/sdk.ts` is classified surface in
`src/boundary.test.ts` (it resolves providers, keys and consent, then calls
into core — never the reverse). Four rulings inside it:

- **The SDK is a mouth, not a second engine.** Every gate is the CLI's own
  function on the same path: `resolveRoute` (so a `private` prompt still needs
  an explicit provider), `isModelAllowed` before `resolveKey` before
  `makePortForConfig` (`src/sdk.ts:267`, `:272`), the unpriced-route refusal of
  a dollar ceiling (`:284`), plan mode, `listRules`, `loadHooks` once per turn.
  A gate that refuses throws from the first iteration, so a call this module
  rejects never contacts a provider — the test for that asserts the *order*
  (enabling the model moves the refusal to the credential check), not just the
  message.
- **`canUseTool` sits on one rung and cannot climb.** It is mounted where the
  ladder reaches `ask`, which is the only place a host decider exists: a policy
  deny, plan mode, the denylist and `disallowedTools` never call it, so a host
  can refuse more and never less. `loop.ts:86` gains `askUserIsHost` for exactly
  one reason — the non-TTY rung exists because a terminal prompt needs a
  terminal, and an in-process callback does not. The CLI never sets it; an ask
  with no `canUseTool` stays held and denied.
- **No `updatedInput`, no host prose into the transcript.** Policy graded one
  string, the audit hashed that string, and the remembered shape was cut from
  it; swapping the arguments after the decision would make the trail describe
  bytes that were never executed, so the field is absent from the type and a
  test sends one anyway to pin that the handler still receives `{"id":7}`.
  A deny's `message` is likewise not forwarded — a caller's text arriving as a
  tool result is a new injection path, and the loop's own refusal is already
  audited. A decider that throws or answers nonsense is a bug in the host, and
  the safe reading of that bug is the rung it was asked about: deny.
- **`port` is a convenience, not a privilege boundary.** Supplying a transport
  replaces the provider/key lookup and nothing else — policy, budgets, audit
  and the ask ladder are downstream of it either way, and `dist/loop.js` has
  never been closed. Pretending otherwise would be marketing, not a gate.

Also verified against the real binary, importing `dist/sdk.js` from outside the
repo (`pollinations:openai-fast`, one host tool, a `canUseTool` that logs and
allows, `maxTurns 4`): `init: pollinations:openai-fast mode=default
custom=["lookup_bug"]`, `[host decider] lookup_bug rule=default:host-tool:ask
subject={"id":42}`, `result: subtype=success turns=2 tools=1`, receipt
`3083 prompt + 119 completion tokens / pollinations:openai-fast 3083+119`,
`total_cost_usd=null` and `cost: cost untracked (see https://pollinations.ai)`
— an unpriced route reports unpriced, never a fake 0 — with
`trace: [{seq:1, tool:"lookup_bug", policy:"allow:default:host-tool:ask",
actor:"human", subject:"{\"id\":42}"}]` and a one-sentence answer that quoted
the tool's output. The declarations ship too (`dist/sdk.d.ts`), so the entry is
typed from the package, not from the source tree.

Wave 3a (task lists with blockers) closed 1 row: `TaskCreate/Get/List/Update`.
HAVE-or-better 40 → 41, GAP 46 → 45, wave 3 24 → 23. 13 new tests in
`src/tools/todo.test.ts`, all 9 pre-existing ones kept as a compatibility
contract (a store written by an older build still loads). Four rulings:

- **`blocked` is derived, never stored.** A status field for it would be a
  second source of truth that can disagree with the edges it names, so an item
  is blocked exactly while one predecessor is not `done`
  (`src/tools/todo-store.ts:176`). The one thing an edge buys — a claim cannot
  be made past it — is enforced at the door (`:133`) rather than rendered as a
  label.
- **An edge that resolves to nothing is refused, not dropped.** A dropped
  blocker is a grant: `blockedBy: ["ghost"]` would quietly make an item
  claimable (`:129`), and a cycle has no satisfying order at all, so it names
  the path (`:131`) instead of deadlocking the list. Either direction may be
  written; both are stored (`:146`), because the graph is one object and the
  caller should not have to know which half of it the renderer reads.
- **Every write re-passes the validator, including `update`.** It reads the
  store, changes one status and writes the whole list back through the same
  parse (`src/tools/todo.ts:47`), so the invariants hold for the file on disk,
  not just for the arguments of the call that happened to be well-formed. A
  hand-edited or older-build store cannot smuggle a claim.
- **Four verbs, one tool, one file.** A task registry with its own process would
  be a second writer to state the audit chain does not cover, and the store is
  harness state by ruling (`docs/moat/00-convergence.md:237`), never a
  deliverable. The tool stayed under its line bar by splitting along its own
  seam — shape and graph rules in `src/tools/todo-store.ts` (classified core in
  `src/boundary.test.ts`), verbs in `src/tools/todo.ts` — and each action is its
  own policy subject (`src/policy.ts:289`), so a team can `deny todo:get`
  without losing the plan.

Wave 3b (the harness's own decisions on a channel) closed 1 row:
`--debug`, `--debug-file`. HAVE-or-better 41 → 42, GAP 45 → 44, wave 3 23 → 22.
11 new tests in `src/debug.test.ts`. Four rulings:

- **It logs why, not what.** The transcript already prints every tool call,
  verdict and hop, on stderr and on the audit chain; a flag that repeated that
  would be a verbosity dial. What had no channel was the reasoning that died
  inside the loop — which rung answered (`src/loop.ts:1140`), why rotation was
  skipped (`:698`), what the transcript weighed at each metering point (`:734`),
  what a hook returned (`:1147`). 16 sentences, chosen because each one is the
  answer to a question an operator has asked out loud.
- **Redaction lives at the sink, not at the call sites.** A debug log is the
  widest leak surface the program has: it sees arguments, subjects and tool
  output. One `clip()` (`src/debug.ts:118`) means a future call site cannot
  forget to scrub, and cannot opt out.
- **The log may not sit next to what it describes.** `*.env*` and any path
  inside `.codewhip/` are refused at parse time (`src/debug.ts:41`), before a
  run starts: the first is the file shape this repo refuses to read, and the
  second is where the audit chain, the stored keys and the policy live. Writing
  the commentary beside the evidence would put both at the same blast radius.
- **A broken diagnostic is a warning, not a failure.** Disk error or 8 MiB cap:
  one line to the prose channel and the sink goes quiet for the rest of the run
  (`src/debug.ts:88`) — the same rule hooks already follow. Lines append
  synchronously (`src/debug.ts:104`) because the tail of the run that crashed is
  the only part anyone ever reads, and a buffered stream is precisely how that
  tail is lost. Subagents inherit the parent's sink (`src/subagents.ts:602`):
  delegation is where surprises hide, and a child that cannot be debugged is a
  child that cannot be trusted. The cost is disk and nothing else — no prompt
  token is added, so receipts are unchanged at `$0` delta.

Wave 3c (what the session has already spent) closed 1 row that was already
PARTIAL: `/context`, `/usage`, `/cost`. HAVE-or-better 42 → 43, PARTIAL 16 → 15,
**GAP 44 and the wave counts unchanged** — flipping a PARTIAL row earns a point
on the bar and does not remove a wave-3 gap, and this file's own rule is that the
count stays arithmetic rather than flattering. 15 new tests in
`src/session-ledger.test.ts`. Four rulings:

- **The numbers are reported, not recomputed.** `agentLoop` now returns the
  shape it actually put on the wire — system prompt, tool specs and the
  compaction ceiling it used (`src/loop.ts:1334`) — and the REPL folds usage plus
  that shape into one session ledger per run (`src/index.ts:1718`). A grid built
  by a second estimate of the prompt would disagree with the run it claims to
  describe, and the disagreement would be invisible.
- **Every figure that is not a meter reading says so.** The grid header names its
  own measure (`est. tokens (chars/4; the same measure compaction budgets with)`),
  a route whose provider never sent a usage block is tagged `(est.)`, and the
  ceiling is labelled the compaction limit rather than the model's window. A
  context read-out is precisely the number a person trusts and then runs out of
  room on, so the honest reading is the useful one. The `history` row is summed
  the way `estimateTokens` sums a whole list, which is what the compactor
  budgets against — the per-role bullets under it are breakdowns and round
  separately.
- **An unpriced leg buys no total.** `.cost` prints the sum only when every route
  in it has a price row; otherwise it names the leg with none and points at its
  console (`src/session-ledger.ts:152`). That is the same rule `--max-budget-usd`
  and the polish gate already follow, so the session read-out cannot quietly
  disagree with the flag that gates a run.
- **The ledger is surface-side, and lives until `.exit`.** It renders lines for a
  human, so it needs the price table — therefore it is classified in `SURFACE`
  (`src/boundary.test.ts:44`), and no core module imports it: the research
  substrate still loads without the provider table. Like the transcript, it is
  in memory during a session and writes nothing; the three verbs are read-only by
  construction. Cost of the feature is the three numbers riding an existing return
  value — no prompt token is added, so receipts are unchanged at `$0` delta.

Wave 3d (what an agent file may say) moved 1 row from GAP to PARTIAL: the ten
subagent frontmatter fields. HAVE-or-better unchanged at 43, PARTIAL 15 → 16,
**GAP 44 → 43, wave 3 22 → 21**. It is scored PARTIAL and not HAVE because two
of the ten fields are honoured while eight are refused — loudly, with a reason,
at load time — and "loudly refused" is not "does what Claude does". 9 new tests
(`src/subagents.test.ts`, `src/frontmatter.test.ts`). Five rulings:

- **`tools:` narrows and cannot widen.** A child's whole authority is read and
  search by construction, so a file naming `bash` would advertise a promise the
  harness breaks on the first call; the parse fails instead
  (`src/subagents.ts:144`). `CHILD_TOOL_NAMES` (`src/tools/types.ts:39`) is now
  the single list that both that check and the child's spec builder
  (`src/tools/registry.ts:301`) read — a second copy is how a file starts naming
  a tool its child cannot use.
- **Narrowing is expressed as a refusal, not as a second mechanism.**
  `tools: read` compiles to one whole-tool refusal for `search`
  (`src/subagents.ts:480`) and joins the child's `disallowedTools` — the same
  list the operator's `--disallowed-tools` fills. So `toolSpecs` un-advertises
  the spec and the ladder refuses the call through the path that already existed
  for both, rather than a frontmatter-only one that could drift.
- **A field that does nothing is a false sentence in a config file.** `permissionMode`,
  `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort` and
  `isolation` are each refused by name with the reason it cannot be honoured
  (`src/subagents.ts:73`), and an unknown key is refused as unknown, so a typo
  surfaces the same way. The refusal is not a shrug: `codewhip agents` prints the
  file as SKIPPED with the line needed to fix it. Accepting-and-dropping
  `permissionMode: acceptEdits` would have been the friendlier behaviour and the
  worse one — the author would find out from a child that did not do what the
  file said.
- **Inheriting the parent's refusals is not a fixed escape, and is not claimed
  as one.** Checked honestly: no filter a child could evade is even expressible
  today, because `read`/`search` take no shape (`src/tool-filter.ts:62`) and a
  child cannot reach the four shapeful tools. What shipped is the difference
  between a child honouring the run's refusals *by construction*
  (`src/loop.ts:1223` → `src/tools/child-run.ts:47` → `src/subagents.ts:599`) and
  by the accident of that grammar — and the reason `tools:` could be built at all
  without inventing a second authority path.
- **Cost is a smaller prompt.** Nothing is added to any system prompt; a
  narrowed child is sent one spec fewer, so its receipt goes down. The refusal
  text for an un-honoured field is spent by whoever reads `codewhip agents`, not
  by a model.

### Wave 3e — asking the human (2026-09-25)

`ask_user` is the thirteenth builtin: the model puts one multiple-choice
question to the human who started the run and their answer arrives as a tool
result (`src/tools/ask-user.ts:82`, `src/index.ts:1606`). The row is PARTIAL, not
HAVE, because three things in Claude Code's schema are not here: up to four
questions per call, the `header` chip, and the `preview` body. The capability the
row named — asking back — ships with tests.

- **An answer is information, not a grant.** `ask_user` is allow-class
  (`src/policy.ts:430`) precisely because it mutates nothing: it reads one line
  from a human and returns it as text, and every edit, shell call and fetch the
  model goes on to attempt still walks the ladder. Grading the *question* as an
  ask would be circular — consent to ask for consent — and in a headless run,
  where asks auto-deny, it would make the tool unreachable by construction. It
  is still deniable: the rule lands after promoted-deny matching and the subject
  is the question text (`src/policy.ts:295`), so `deny ask_user:Revert the
  branch?*` in policy.md holds.
- **The tool is advertised where a human is, and not elsewhere.** One spec is
  gated on a capability instead of a policy (`src/tools/registry.ts:316`):
  headless `-p`, an SDK `query()` and a TUI whose bridge draws approval but not
  questions all get the twelve that can actually run. The principle is the one
  already used for children and for `--disallowed-tools` — never advertise what
  the harness will refuse — and `runAskUser` still refuses without a channel, so
  a fabricated call cannot conjure a keyboard.
- **One keyboard, one owner.** A child that could prompt would be the parent's
  consent gate with a second caller, so the loop refuses it before the ladder
  (`src/loop.ts:884`, `loop:child-no-prompt`) and the deny lands on the child's
  own audit runId — not the parent's trace, which is what keeps the two runs
  separable afterwards.
- **Free text outranks the menu.** A number in range picks an option; anything
  else — a sentence, an out-of-range digit, an option typed verbatim in another
  case — becomes the human's own answer (`src/index.ts:995`). A forced choice is
  a interrogation, and the interesting answers are the ones nobody listed.
- **Silence is a refusal, never an empty yes.** An interrupted or unanswered
  question returns `ok: false` naming the question, and a headless call returns
  the question it could not ask. The model must not be able to read "no
  response" as permission to proceed.
- **Cost: one round-trip, and only when it can land.** No prompt text is added
  anywhere; the usage guidance lives in the spec, which is sent only when the
  spec is advertised. A run with no human pays nothing for the tool at all.

### Wave 3f — the roster on the command line (2026-09-25)

`.codewhip/agents/*.md` already made a subagent a committed file. `--agents
'{"scout":{…}}'` is the same roster typed once, for a run that should not leave
a trace (`src/subagents.ts:209`), and `--agent scout` puts an entry on the main
thread instead of a child's (`src/index.ts:670` → `src/subagents.ts:522`). The
row is PARTIAL: three deltas remain and each is named in the matrix. 14 new
tests (`src/subagents.test.ts`, `src/agents-flag.test.ts`).

- **Two sources, one compiler.** A `--agents` entry is parsed into the same
  `AgentDef` and passed through the same `parseToolsField` and `entryProblems`
  as a file (`src/subagents.ts:173`), so a flag cannot be laxer than a commit:
  `tools` still narrows only, `maxTurns`/`max_steps` still bound 1–25, and
  `permissionMode` is still refused BY NAME. One cap does the size work —
  64 KB of payload (`src/subagents.ts:188`) instead of the 8 000-char prompt cap
  a file has, because the JSON carries names and descriptions too.
- **Precedence is a ranking of specificity, and it is visible.** built-ins →
  files → `--agents` (`src/subagents.ts:424`, merged into the loop's own roster at
  `src/loop.ts:426`): the thing typed for this run outranks the thing committed,
  which outranks the thing shipped. The flag list is handed to the delegation
  tools as `ctx.agents` (`src/tools/types.ts:128`), so `codewhip agents`, the
  parent's roster line and `delegate` all resolve the same name to the same
  entry — a flag that only the summariser could see would be a false roster.
- **An entry that cannot be honoured stops the run before a token is spent.**
  Both flags resolve at parse time, so malformed JSON, a bad name or a duplicate
  `--agent` returns `null` from `parseRunArgs` and prints the reason
  (`src/index.ts:660`), and `--agent nosuch` prints the roster it searched:
  `codewhip: --agent "nosuch" is not on the roster (explore, plan, review)`,
  followed by a `$0.0000` receipt. A roster that half-loads surfaces later as
  `unknown agent "…"`, which is a different bug's error message.
- **The persona appends; it does not replace.** Claude Code's agent definition is
  the system prompt. Here the entry's prompt is joined to the harness base
  (`src/subagents.ts:522`), because the base is what tells the model which calls
  get refused: replace it and the model retries denys until it learns by
  collision. Children still replace — their whole authority is two allow-class
  tools, so there is no refusal policy to forget.
- **Authority on a main thread is still the operator's.** `--agent` compiles
  through `agentFilters` like a child (`src/subagents.ts:480`), and that reuse is
  exact: `tools` narrows over the CHILD set, so on a main thread it can refuse
  `read` and `search` and nothing else. Widening or muting the ladder stays
  `--disallowed-tools` / `--permission-mode` business; an agent file is a persona
  plus a narrowing, never a grant.
- **Model precedence, and what pinning costs.** An entry's `model` applies only
  when `--model` was not typed (`src/subagents.ts:522`), and applying it turns
  rotation off — `--models a,b` are candidates for one routed family, so
  honouring a pinned model while hopping between them would be a run that lies
  about which model answered. The banner says all of it: `!! --agent auditor:
  its 10-char prompt joins the system prompt and re-pays every turn; model pinned
  to some/model (rotation off — candidates belong to the routed family)`.
- **`maxTurns` is not applied to a main thread.** A run's step budget is
  `--max-steps`, the operator's; silently truncating a human's own run at an
  entry's 12 steps would be a surprise paid for in lost work. It bounds children
  only, and the row carries that as a delta rather than pretending otherwise.
- **Cost is prompt text, and it shares one budget.** The persona is appended into
  the same `APPEND_MAX_CHARS` (8 000) tail as `--append-system-prompt[-file]` and
  checked before the run, so the cap errors instead of slicing a sentence in half
  (`src/index.ts:1145`). No new lines are added anywhere else: a run without
  `--agent` pays nothing for the feature.

Definition of done for this program, so the audit is arithmetic: **every
in-scope GAP row has shipped behaviour, tests and a CHANGELOG entry**, wave by
wave, and no row is downgraded to close a gap. Completion is claimed only when
the GAP count in this file is zero or each remaining row carries a recorded
ruling that it is out of scope, and only with `npm run parity` exiting 0 — the
count is the instrument, not the memory of it.

## Build queue

1. **Wave 1 — headless scripting.** stdin piping, `-p/--print`,
   `--output-format text|json|stream-json`, `--max-budget-usd`. **Closed
   2026-09-24** (`src/run-output.ts`, `src/loop.ts` `stopReason`/`costCheck`).
   The stdout/stderr split is the durable decision: in headless mode stdout is
   data and prose belongs on stderr, so a script can pipe the result and a human
   can still read why a run refused.
2. **Wave 2 — session and control surface.** `--name`/`/branch`/`--fork-session`
   **closed 2026-09-24** (`src/sessions.ts`, `src/index.ts` `-r`/`.rename`);
   `--allowed-tools`/`--disallowed-tools` + `--append-system-prompt[-file]` +
   `--exclude-dynamic-system-prompt-sections` **closed 2026-09-24**
   (`src/tool-filter.ts`, `src/system.ts`);
   `--permission-mode` ladder + `--add-dir` + `permissions.defaultMode`
   **closed 2026-09-24** (`src/settings.ts`, `src/tools/jail.ts`,
   `src/loop.ts`, `src/checkpoints.ts`);
   `--json-schema` **closed 2026-09-24** (`src/structured.ts`,
   `src/loop.ts:784`, `src/run-output.ts`);
   `--input-format stream-json` **closed 2026-09-24** (`src/stream-input.ts`,
   `src/index.ts:1122`);
   the public programmatic entry **closed 2026-09-24** (`src/sdk.ts` —
   `query()`/`tool()`/`canUseTool`, on top of the host-tool substrate in
   `src/tools/registry.ts` and the structured ask in `src/loop.ts`). **Wave 2
   is complete: no row is left in it.**
3. **Wave 3 — agent capability.** task-list blockers **closed 2026-09-25**
   (`src/tools/todo-store.ts`, `src/tools/todo.ts`); `--debug`/`--debug-file`
   **closed 2026-09-25** (`src/debug.ts`); `.context`/`.usage`/`.cost` over a
   session ledger **closed 2026-09-25** (`src/session-ledger.ts`,
   `src/loop.ts:1334`) — a PARTIAL row, so the wave-3 GAP pile is untouched.
   Subagent frontmatter **advanced GAP → PARTIAL 2026-09-25** (`tools` and
   `disallowedTools` honoured, the other eight refused by name) — GAP 44 → 43,
   the first wave-3 row to move since task-list blockers.
   `ask_user` **advanced GAP → PARTIAL 2026-09-25** (the model asks one
   multiple-choice question back; four-questions-per-call, `header` and `preview`
   are the named deltas) — GAP 43 → 42, wave 3 21 → 20.
   `--agents` JSON + `--agent` **advanced GAP → PARTIAL 2026-09-25** (the file
   roster in JSON, three-source precedence, and an entry on the main thread;
   append-not-replace, child-only `tools` narrowing and no mid-session switch are
   the named deltas) — GAP 42 → 41, wave 3 20 → 19.
   Remaining: parallel tool
   exec, vision input, prompt caching, hook events 3→33 with
   `additionalContext`/`matcher`/`if`, the eight un-honoured agent fields plus
   the `.claude/agents/` path itself,
   web search tool, worktree isolation, MCP client (with
   ruling), effort/thinking.
4. **Wave 4 — extensibility and install.** skills, http/agent hook types,
   `--bare`, command `!cmd`/`@file`, memory imports and rules dirs,
   NotebookEdit, OS sandbox profiles, per-turn checkpoints + transcript rewind,
   update path, `setup-token`.
5. **Wave 5 — deferred pending user pain.** plugin marketplace, vim keymap,
   statusline/theming, `/loop`+`/goal`, `/batch`, `/insights`, `--import`,
   `--btw`, LSP.
