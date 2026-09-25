# 19 — QoL parity batch: todo tool, custom slash commands, hooks

Ratified 2026-09-21. Scope: three widely-used quality-of-life
features, per the approved plan. Framing constraint honored: kill-list
rule 3 bans "MCP catalog, plugin marketplace, or skills library" — none
of these is a marketplace. Hooks are config, commands are prompt
expansion, todo is harness state. Zero new runtime dependencies; every
new file is Node-builtins-only and registered in `boundary.test.ts`
CORE_EXPECTED (all three are core; none imports surface).

## What shipped

1. **`todo` tool** — the model maintains a task checklist in
   `.codewhip/todos.json` (single-JSON rewrite, `writeOwnerOnlyFile`,
   `redactSecrets` on every item at save). Actions `list | replace |
   update`; validated inputs (≤64 items, unique ids, ≤1 `in_progress`),
   failures returned as `ok:false` strings, never a throw. Policy:
   explicit `default:todo:allow` branch — it mutates only harness state,
   never the workspace; a team can still promote a `deny todo:` in
   `policy.md` (the allow lands after promoted-deny matching). Children
   (depth > 0) are denied explicitly (`loop:child-readonly`): `toolSpecs`
   already hides it from them, but `lookupTool` admits any `TOOLS` key,
   so the loop-level guard closes the model-fabricated-call path.
   Plan-mode top-level runs MAY use it — planning *is* the task there.

2. **Custom slash commands** — `.codewhip/commands/<name>.md` (flat
   frontmatter via the shared `src/frontmatter.ts` parser extracted
   verbatim from `parseAgentFile`; one parser, one error grammar).
   `$ARGUMENTS` substitution; a body without the placeholder gets
   `ARGUMENTS: <rest>` appended (the usual convention). REPL:
   `.help` lists commands; unknown `/name` prints an error and does NOT
   reach the model. One-shot `run`: expansion only on an exact match —
   an unmatched `/foo` prompt runs verbatim, because one-shot prompts
   are routinely quoted text that starts with a path. The asymmetry is
   deliberate and pinned by tests both ways.

3. **Hooks** — `hooks.json` in `configDir()` (global) merged with
   `.codewhip/hooks.json` (project), fail-soft load, ≤16 defs. Events:
   `PreToolUse | PostToolUse | Stop`, matched by tool name or `*`.
   Execution: user shell, 10s hard timeout, 64KB stdout cap, JSON
   payload on stdin + `CODEWHIP_*` env, sequential.

## Rulings (the six settled decisions)

1. **Hook infra failure = warn + proceed; only an explicit assertion
   denies.** Exit 2 or exit-0 stdout `{"decision":"deny"}` is a veto;
   timeout/crash/exit 1 is the *absence* of a signal, and absence must
   not masquerade as an assertion. This does not contradict the
   approval fail-closed rule: an approval timeout means a human veto was
   never granted, while a hook timeout is a broken guard on the user's
   own machine — degraded ≠ blocked, and the warning is loud per call.

2. **Hooks are downstream of redaction.** `PostToolUse` receives the
   redacted tool output and redacted args — the loop's invariant is
   "redact before anything downstream" (loop.ts:824 comment), and a hook
   whose stdout flows into user pipelines is exactly the exfil channel
   `redact.ts` exists to close.

3. **`Stop` hooks are observe-only.** No block-continue: forcing
   continuation is a token-spend amplifier, and the honest stop
   governors (`maxSteps`, `tokenBudget`, compaction) are the ones whose
   receipts users trust. Verdict output from Stop hooks is ignored
   (warnings only).

4. **Shared frontmatter parser.** `src/frontmatter.ts`
   (`parseFlatFrontmatter`) extracted from `subagents.ts:102–119`;
   `parseAgentFile` refactored onto it as a pure extraction — the
   existing agent tests are the behavior pin; if any of them needed
   editing, the extraction was wrong.

5. **One-shot expansion is exact-match-only, REPL errors on unknown
   commands.** Leading `/` in a REPL is unambiguous intent; leading `/`
   in a shell-quoted one-shot prompt is frequently a path.

6. **Audit actor union stays frozen** (`policy|human|remembered|yolo`).
   A hook denial records actor `"policy"` with `ruleId:"hook:pretool"` —
   no schema change, no migration. Hook warnings are deliberately NOT
   chain entries (they gate nothing); the outcome record gains the
   additive `hooks?: {fired, denied, warned}` counter, per the
   2026-09-10 "optional additive fields only" freeze practice.

## Hooks threat model (outside-the-jail, stated plainly)

Hook commands execute with the user's shell privileges, outside the
bash-tool jail, BY DESIGN (the same stance as these hooks): they are
user-authored config, not model-authored tool calls. Containment comes
from where configs may live and when they load:

- Only `configDir()/hooks.json` and `<cwd>/.codewhip/hooks.json` are
  read — paths `write.ts` already refuses and `denylist:self-protected`
  already blocks bash from touching, so the agent cannot register or
  rewrite a hook through its own tools.
- Hooks load ONCE at run start (before any model call) and the loaded
  set is immutable for the run: a prompt-injected model cannot widen
  the surface mid-run.
- The PreToolUse seam fires AFTER the repeat-guard memo and immediately
  before exec, so hooks observe executions, not attempts — a memoized
  repeat fires no side-effecting user command.
- Residual risk is the honest one: whoever can edit files on your
  machine outside CodeWhip can install a hook. That is true of shell
  profiles, git hooks, and every editor; CodeWhip's contribution is
  that the two load paths are self-protected against the *agent*.

## Documented limitations (not silently absent)

- Child runs (subagents) get no hooks in v1 — `runChildAgent` does not
  thread them; delegation already grants no authority beyond read/search.
- The TUI composer cannot submit mid-run `/name` commands (run-scoped
  bridge, documented in `05-tui-spike.md`); custom commands are a
  REPL/one-shot feature.
- `todos.json` is global-per-repo, not per-run; concurrent runs share it
  (same trade `policy.md` promotion already makes).
