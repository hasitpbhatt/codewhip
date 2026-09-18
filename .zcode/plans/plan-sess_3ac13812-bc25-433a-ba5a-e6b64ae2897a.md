# TUI Spike Implementation Plan

## Context

The TUI spike (`docs/moat/05-tui-spike.md`) converged on 2026-09-18: a flag-gated, headless-default TUI built on OpenTUI. It ships behind `--tui`, with `--no-tui` forcing an 80-col screen-reader fallback. `LoopEvent` is frozen (5 kinds); the TUI bridges via `onEvent` + the existing `askUser` promise, resolving fail-closed `no` on Esc/timeout/unmount.

## Architecture

Three modules under `src/tui/`, each <300 lines, with an isolated tsconfig so TUI types never leak into the headless build:

| Module | Responsibility | Reuse |
|---|---|---|
| `bridge.ts` | Approval-as-promise resolver + `onEvent` tail subscription. Replaces `promptApproval`'s readline when `--tui` is active. | `askUser` promise contract from `src/loop.ts:19-20` |
| `model.ts` | In-memory ring: transcript tail (~200 line cap), one pending approval, background card states, meter counters. 500ms poll loop. | None new |
| `view.tsx` | 5-region render (header, transcript tail, pending-approval card, composer, footer) + keymap (`y/s/a/n`, Esc, Ctrl-C) + slash commands. | 5-region model from spike doc §2 |

## Changes Required

### 1. `src/index.ts — Flags & Integration`
- **Add to `RunOptions` type** (`src/index.ts:44`): `tui: boolean` and `noTui: boolean` fields.
- **Add to `parseRunArgs`** (`src/index.ts:340`): parse `--tui` (set `tui: true`) and `--no-tui` (set `noTui: true`). These are mutual-exclusion with a sensible default (`tui: false, noTui: false`). Headless behavior is unchanged.
- **Wire into `cmdRun`** (`src/index.ts:591`): when `opts.tui` is true and `opts.noTui` is false, lazy-import `src/tui/bridge.js` → `createTuiBridge()` and pass its `askUser` + `onEvent` to `agentLoop` instead of `promptApproval` / the bare `console.log` callback at line 761/769. When `opts.noTui` is true, force the existing `console.log` path with a note.
- **Update `printRunOptions`** (`src/index.ts:81`): document `--tui` / `--no-tui` flags.

### 2. `tsconfig.tui.json — Isolated Build Config`
A new tsconfig at repo root with:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "opentui",
    "noEmit": true
  },
  "include": ["src/tui/**/*"],
  "references": [{ "path": "./tsconfig.json" }]
}
```
This keeps TUI imports/opt-in and ensures headless `tsc` (which uses `tsconfig.json` with `include: ["src"]`) compiles `src/tui/` only for type-safety, while OpenTUI types are resolved lazily and never shipped to headless.

### 3. `src/tui/bridge.ts` (<300 lines)
- Exports `createTuiBridge(model, view)`: returns `{ askUser: AskUser, onEvent: (e: LoopEvent) => void }`.
- `askUser` returns a promise that resolves on `view.renderApproval(question)` — the view handles `y/s/a/n` keys; Esc, unmount, or timeout resolve `"no"`.
- `onEvent` pushes `LoopEvent.text` into `model.ring` (transcript tail) and triggers `view.rerender()`.
- Must never throw into the loop — wraps everything in try/catch, resolves `"no"` on internal error.

### 4. `src/tui/model.ts` (<300 lines)
- `TuiModel` class with:
  - `ring: string[]` — append-only, capped at 200 lines (asserted in constructor + push).
  - `pending: ApprovalState | null` — single pending approval card.
  - `background: BackgroundCard[]` — pinned task states.
  - `meter: { tokens: number; estCost: number; mix: Record<string, number> }` — live counters.
  - `pollBackground()` — 500ms interval, calls existing background task status APIs.
  - `appendEvent(line: string)`, `setPending(q: string)`, `clearPending()`.
- No persistence — pure in-memory.
- `start()` / `stop()` for the poll interval.

### 5. `src/tui/view.tsx` (<300 lines)
- Lazy-imports OpenTUI at function scope: `const { render, Text, Box } = await import("opentui")`.
- Renders 5 regions per spike doc §2.
- Handles keymap: `y` → `resolve("yes")`, `s` → `resolve("session")`, `a` → `resolve("always")`, `n`/`Esc` → `resolve("no")`; `Ctrl-C` → unmount + abort parity with headless (via the existing `AbortController` at `src/index.ts:744`).
- Composer single-line input: `/model`, `/free`, `/plan`, `/rollback`, `/sessions` slash commands — these emit events that modify the model or trigger existing CLI commands.
- Footer: rollback id + revoke hint + meter (`tokens/mix/$` est.-labeled).
- `--no-tui` / 80-col: renders plain `console.log` lines only, no ANSI box drawing.

### 6. `package.json — OpenTUI Optional Dep`
- Add `"opentui"` to `peerDependencies` (optional) so headless installs don't pull it.
- Headless `npm run lint/typecheck/build/test` must pass with OpenTUI uninstalled.

### 7. Tests — `src/tui/bridge.test.ts`
- Reuse the `makeFakePort` testkit pattern (`src/testkit/fakePort.ts`) to script a fake `ChatPort` returning scripted responses.
- Test the bridge in isolation:
  - `askUser` resolves `"yes"` on `y`, `"no"` on Esc/timeout, `"always"` on `a`.
  - `onEvent` appends to model ring correctly, respects 200-line cap.
  - Bridge never throws into the caller — internal errors resolve `"no"`.
- Mock the OpenTUI view to avoid needing the real package in tests (lazy import makes this trivial with `import.meta.jest`-style stubbing, or simple dependency injection).
- Test gates from spike doc §4: absent-package build, abort parity, redaction, persistence (zero new files), 80-col.

## Build Order (matches spike doc §5)

1. **`src/tui/bridge`** — approval-as-promise + `onEvent` tail subscription.
2. **`src/tui/model`** — in-memory ring + meter counters.
3. **`src/tui/view`** — 5 regions + cards + composer + footer + keymap.
4. **`--tui` / `--no-tui` flags** + lazy import + isolated tsconfig.
5. **`captureBefore` diff-preview** (~15 lines) + rollback footer — `captureBefore` already exists in `src/checkpoints.ts`, so this is a read-only integration.
6. **Slash commands** on existing CLIs.
7. **Background pinned cards** at 500ms poll.
8. **Gates**: absent-pkg build, redaction sweep, persistence, abort-parity, 80-col.

## Constraints Honored (from AGENTS.md + spike doc)

- **No new runtime deps** without PR justification. OpenTUI is an optional peer dependency (approved by the 2026-09-18 ruling). All new code uses only Node builtins + OpenTUI.
- **Every tool/module <150 lines** (spike doc says <300 for TUI views, AGENTS.md says <150 for loop-exposed tools — the TUI modules aren't loop-exposed tools, so <300 per the spike doc applies).
- **JSON I/O, validated inputs, timeout-bounded, never throws** — bridge follows the `ToolResult`-style "return a string, never throw" contract from `src/tools/types.ts`.
- **Zero new writers/persistence** — TUI reuses `saveSession`, `appendOutcome`, `appendEntry`, etc. No `.codewhip/` schema changes.
- **`LoopEvent` frozen** — no changes to `src/loop.ts` event types.
- **Headless regression = 0** — `npm run build/typecheck/lint/test` pass with OpenTUI uninstalled.

## Open Questions (from spike doc §6 — I'll take the documented defaults unless you object)

1. **Ship the spike?** → YES, flag-gated, zero headless regression.
2. **OpenTUI optional dep vs vendored?** → Optional lazy dep.
3. **Pilot metric to graduate?** → ≥4-5 trusted runs/team/week, zero bypasses, `audit --verify` 100%, over 2 weeks.
4. **Diff preview length?** → Keep ~15 from `captureBefore`.
5. **Queue?** → Zero in v1.
6. **Rollback picker?** → Footer + `rollback <id>` only.

I'll proceed with defaults 1-6 unless you want to override any.

## Out of Scope

- No `LoopEvent` widening. No markdown-diff-rich viewer. No queue. No themes/mouse/selectors. No hosted share. No history file. No verdict picker (verdict keys live behind an explicit separate mode, not bare keys that collide with `y/s/a/n`).
