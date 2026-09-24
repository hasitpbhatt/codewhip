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
| `claude "query"` interactive start | HAVE | `src/index.ts:2227` |
| `-p/--print` headless one-shot | HAVE | `-p`/`--headless` (`src/index.ts:535`); `src/run-output.ts` owns stdout, prose moves to stderr. `--print` keeps its older share-markdown meaning — the long name diverges, the short flag does not |
| `cat file \| codewhip -p "query"` stdin piping | HAVE | `readStdin` (`src/run-output.ts:92`): stdin is the prompt when there is no argv prompt (`src/index.ts:2387`), and is appended as context when there is one (`src/index.ts:2406`) |
| `--output-format text\|json\|stream-json` | HAVE | `src/run-output.ts:22` parse, `:161` result document, `:208` emit; NDJSON init/event/result on stream-json |
| `--input-format stream-json` | **GAP-2** | absent |
| `--json-schema` validated result | **HAVE** | `src/structured.ts` — `parseSchema:34` (subset enforced at the door, names the offending keyword and its path), `validateJson:100`, `extractJson:223`; the gate is in the loop at `src/loop.ts:672` (one billed repair round, then `stopReason: "error"`); flags at `src/index.ts:666`/`:677`, resolved pre-flight at `:1236`; `structured_output` beside the prose at `src/run-output.ts:208` |
| `--max-budget-usd` | HAVE | `src/index.ts:546` parse, `:1065` mid-run `costCheck` over `meteredCost` (`src/router.ts`); refuses an unpriced route rather than going inert (`src/index.ts:1021`) |
| `--max-turns` | ALIAS | `--max-steps 25` |
| `--allowedTools` / `--disallowedTools` | HAVE | `src/tool-filter.ts:46` parse, `:146` match; `src/loop.ts:755` grant inside ask, `:715` refuse above the ladder; `src/index.ts:585`/`:593` (both spellings + `=` form) |
| `--append-system-prompt[-file]`, `--exclude-dynamic-system-prompt-sections` | HAVE | `composeSystemPrompt` (`src/system.ts:55`), called from `src/loop.ts:325`; flags at `src/index.ts:601`/`:609`/`:615`, file read pre-flight at `:1098` |
| `--model` / `--fallback-model` | HAVE | `--model`, `--models`, `--failover`, `--free` |
| `--effort low…max` | **GAP-3** | no thinking-budget control |
| `--permission-mode` 7 modes | **HAVE** | six modes shipped (`default`/`acceptEdits`/`plan`/`bypassPermissions`/`dontAsk`/`manual`) — set at `src/settings.ts:21`, exact-match parse `:32`, flag parse `src/index.ts:604`, precedence `:1028`, ladder rungs `src/loop.ts:784`–`:822`. The 7th (`auto`) is the classifier row below, not counted twice. Before Wave 2c this row was `--plan` + `--yolo` only |
| `--add-dir` multi-root | **HAVE** | `src/tools/jail.ts:23` `resolveRoots` (existence + realpath + `MAX_ROOTS:5`), `:76` read and `:104` write containment over all roots; flag parse `src/index.ts:616`, validation before the run `:1031`; `src/checkpoints.ts:65` admits an out-of-cwd target so `rollback` can undo it; threaded through `src/tools/types.ts:40` → read/edit/write/search → `src/subagents.ts:242`. Was a single-cwd jail before Wave 2c |
| `--bare` (skip discovery of hooks/skills/commands) | **GAP-4** | absent |
| `--debug`, `--debug-file` | **GAP-3** | absent |
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
| `--name` / `--fork-session` / `/branch` | HAVE | `--name` + `--fork-session` at `src/index.ts:580`/`src/index.ts:595`, identity decided by `sessionIdentity` (`src/sessions.ts:187`); `.branch` in the REPL at `src/index.ts:1415` |
| `/rename`, `/tag`, `tagSession()` | HAVE | `codewhip sessions rename\|tag` (`src/index.ts:1329`) over `labelSession` (`src/sessions.ts:263`); REPL `.rename`/`.tag` at `src/index.ts:1393` |
| `/clear [name]`, `/compact [instructions]` | PARTIAL | compaction is automatic and model-aware (`src/compact.ts`); no manual `/compact`, no instructions arg |
| `--autocompact auto\|tokens` | ALIAS | `compactTokens: 0` to disable |
| `/context`, `/usage`, `/cost` | PARTIAL | receipts print tokens/model/`$`; no context grid |
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
| `permissions.defaultMode` | **HAVE** | `src/settings.ts:56` `mergeFile` reads `defaultMode` (`:85`) and its twin `additionalDirectories` (`:95`), reporting and ignoring a bad value; `:117` `loadSettings` layers user then project, project wins; consumed once at `src/index.ts:1025` |
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
| TaskCreate/Get/List/Update | **GAP-3** | one flat list, not per-item tasks with blockers |
| Agent/`Skill` tool | PARTIAL | `delegate`, `delegate_many`; no model-invoked skills |
| AskUserQuestion | **GAP-3** | the model cannot ask a multiple-choice question back |
| ToolSearch / WaitForMcpServers | **GAP-3** | absent (MCP) |
| EnterWorktree/ExitWorktree, `isolation: worktree` | **GAP-3** | absent; worktree *escape* is denied today |
| LSP tool | **GAP-5** | absent |
| CronCreate/List/Delete, RemoteTrigger, PushNotification, SendUserFile, EndConversation, ReportFindings, Artifact | N/S | cloud/push platform surface |
| Image input to Read | **GAP-3** | `LoopMsg.content` is `string` (`src/provider-port.ts:18`); `read` refuses binary (`src/tools/read.ts:68`) |
| Parallel tool execution | **GAP-3** | `src/loop.ts:577` sequential `for`; deferred in `torvalds-architecture-review.md:105` |
| Prompt caching | **GAP-3** | no `cache_control` anywhere in `src/` |

## E. Subagents and delegation

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `.claude/agents/*.md` + frontmatter | PARTIAL | `.codewhip/agents/<name>.md`, only `description`/`model`/`max_steps` (`src/subagents.ts`) |
| `tools`, `disallowedTools`, `permissionMode`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, `isolation` frontmatter | **GAP-3** | not honoured |
| `--agents` JSON, `--agent` | **GAP-3** | absent |
| Built-in Explore / Plan / general-purpose | ALIAS | `explore`, `review`, `plan` |
| Agent view panel, parallel background agents, `SendMessage`, teammates | **GAP-3** | children are synchronous and depth-capped |
| Subagent on global audit chain, budget split, folded receipts | **HAVE-plus** | `src/tools/child-run.ts` |

## F. Hooks

| Claude Code | Status | codewhip evidence |
|---|---|---|
| `PreToolUse` / `PostToolUse` / `Stop` | HAVE | `src/hooks.ts` |
| `SessionStart`, `Setup`, `UserPromptSubmit`, `Notification`, `PreCompact`/`PostCompact`, `SubagentStart`/`Stop`, `TaskCreated`/`Completed`, `PermissionRequest`/`Denied`, `SessionEnd`, `FileChanged`, `ConfigChange`, `CwdChanged`, `WorktreeCreate`/`Remove`, `InstructionsLoaded`, `Elicitation`, `MessageDisplay`, `StopFailure`, `TeammateIdle`, `PostToolBatch`, `UserPromptExpansion` — 30 more events | **GAP-3** | 3 of 33 exist |
| `matcher` regex + `if` permission-rule syntax | PARTIAL | `match` is a bare tool name |
| `additionalContext`, `updatedInput`, `systemMessage`, `continue`, `async`, `once`, `statusMessage`, `asyncRewake` | **GAP-3** | only deny/allow decision + reason |
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
| Agent SDK (TS/Python `query()`, `canUseTool`, custom tools) | PARTIAL → **GAP-2** | `src/loop.ts` is importable and core-clean (`src/boundary.test.ts`) but there is no public programmatic entry |

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
**102 in-scope rows** — **HAVE/ALIAS/HAVE-plus 38**, **PARTIAL 16**, **GAP 48**,
i.e. **37.3%** at parity or better. Remaining GAP rows by wave: 2 → 2, 3 → 24,
4 → 13, 5 → 9.

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
  `--allowed-tools` (`src/loop.ts:784`), not a remembered rule (`:848`), not
  `--yolo`, because an operator who says "ask me" has already answered the
  question the other flags would answer.
- **Six modes, not seven.** `auto` is deliberately absent: it names a
  classifier, and shipping the word without the judgement behind it would add
  a label that behaves like `acceptEdits` and advertises something else. It is
  the §C classifier row, which stays GAP-3.
- **`plan` is structural, not a permission.** `--plan` outranks `--yolo` and
  `--allowed-tools` (creed, `docs/moat/00-convergence.md`), so a mode string
  cannot un-plan a run either: `src/loop.ts:335` ORs the two sources and the
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
37 → 38, GAP 49 → 48; the wave-2 remainder is now 2 rows (`--input-format
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
  (`src/loop.ts:672`, `MAX_REPAIRS = 1`), so `num_turns`, `steps`, token usage
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
(`src/index.ts:1243`): a plan is prose, and arming both would spend tokens
producing a document the run has already decided not to act on. Resolved
before any request goes out (`:1236`), unreadable `--json-schema-file` bails
the same way, and the schema's size is reported in the init document as
`json_schema_chars` (`:1381`) so a caller can see what it paid to enforce.

Also verified against the real binary: asking for `{name, year}` with a schema
requiring a `pattern` on `name` printed `!! --json-schema armed:…`, then
`◈ structured answer rejected (2 problem(s)) — asking for a repair, attempt
1/1`, then `{"name":"Windows","year":1985}` on stdout, with
`receipt: 4494 prompt + 48 completion tokens / llm7:default` — two turns,
charged as two turns.

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
   `src/loop.ts:672`, `src/run-output.ts`);
   still open: `--input-format`/stream-json input, public
   programmatic entry.
3. **Wave 3 — agent capability.** parallel tool exec, vision input, prompt
   caching, hook events 3→33 with `additionalContext`/`matcher`/`if`,
   subagent frontmatter, task-list tool, `AskUserQuestion`, web search tool,
   worktree isolation, MCP client (with ruling), effort/thinking, `--debug`.
4. **Wave 4 — extensibility and install.** skills, http/agent hook types,
   `--bare`, command `!cmd`/`@file`, memory imports and rules dirs,
   NotebookEdit, OS sandbox profiles, per-turn checkpoints + transcript rewind,
   update path, `setup-token`.
5. **Wave 5 — deferred pending user pain.** plugin marketplace, vim keymap,
   statusline/theming, `/loop`+`/goal`, `/batch`, `/insights`, `--import`,
   `--btw`, LSP.
