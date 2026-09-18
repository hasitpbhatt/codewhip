# TUI spike — converged conclusion (OpenTUI, headless default)

RESEARCH ONLY, no code. Decisive; no ties. Inputs: Linus (harness jail),
Naval-leverage (compounding), Norman (panic legibility), Memory (persistence).

## 1. Final converged scope

**SHIP (v1 spike, behind `--tui` only; headless stays default):**
transcript-thin + composer-single + status meter; approval-as-promise bridge
(fail-closed `no` on Esc/timeout/disconnect); tool cards ok/deny/held; inline
`y/s/a/n` (existing ask ladder) with scope + revoke hint; capped ~15-line diff
preview sourced from `captureBefore` before-image only; persistent rollback
footer (`rollback <runId-prefix>`, no picker); background cards pinned (poll);
live meter with est./untracked honesty; slash `/model /free /plan /rollback
/sessions`; Esc-cancel + Ctrl-C-abort identical to headless; 80-col +
`--no-tui` screen-reader fallback.

**EXPLICITLY NOT (v1 kill list, needs ruling to reopen):** no `LoopEvent`
widening; no markdown-rich transcript; no queue (zero, not even one — single
flight); no diff-rich viewer; no pickers; no hosted share; no themes; no mouse;
no selectors; no streaming; no `ask_user` TUI widget; no LLM-compaction UI; no
spill/pack-GitHub surfaces; no titles/favorites/search-index (until >50
sessions); no history file; no new persisted files.

## 2. Architecture

- **Flags:** `--tui` opts in; headless is default. `--no-tui` forces plain
  screen-reader-safe output (80-col, no mouse, no ANSI-required layout).
  `--plan`, `--continue`, `--yolo`/CI `ask=>deny` semantics unchanged in TUI.
- **Lazy import:** OpenTUI is an optional lazy import inside the TUI entry
  only; headless `build`/`test` pass with the package absent. Isolated
  tsconfig/JSX for `src/tui/` so TUI types never leak into the loop.
- **Bridge:** do NOT widen `LoopEvent` (`tool|retry|failover|policy|compact`
  frozen). TUI drives the existing loop via `onEvent` + existing `askUser`
  promise: TUI renders the pending approval card and resolves the promise on
  `y/s/a/n`; Esc/timeout/unmount resolves fail-closed `no`. No new event
  kinds, no new loop args in v1.
- **Model (in-memory only):** append-only ring: transcript tail (cap ~200
  lines), one pending approval, background card states, meter counters. TUI
  polls background state at 500ms and renders tail only — never full history.
- **View (5 regions, `src/tui/{bridge,model,view}`, each <300 lines):**
  1 header (run/class/budget), 2 transcript tail, 3 pending-approval card,
  4 composer (single line) + footer (rollback id + revoke hint + meter
  `tokens/mix/$` est.-labeled). Tool cards show `ok/deny/held` + rule id.
- **Keymap:** `y` once, `s` session, `a` remember-shape (existing ladder),
  `n`/`Esc` deny-and-close; `Ctrl-C` aborts run same as headless. Verdict keys
  (if any) live behind an explicit separate mode/prefix — never bare keys that
  collide with the ask ladder.

## 3. Persistence / redaction / perms contract

- Persist ONLY via existing writers: `saveSession` iff `--continue` armed;
  `appendOutcome`/`appendEntry` via loop; `setVerdict` explicit;
  `persistRule`/`approve`/`share` explicit. TUI adds zero writers, zero files.
- Scrollback, input, search, transcript stay in-memory ring; no history file.
- Every rendered string passes through existing `redactSecrets` points
  (loop preview cap + share scrub); env-assignment values scrubbed, names kept.
- Any new file (none proposed) would require `secure-file` 0600/0700 + ruling;
  since none is proposed, the contract is: no new files, no perms change.
- `remembered.jsonl` provenance + `.codewhip/**` self-protect + `audit.log`
  hash chain apply unchanged; TUI approval clicks are the same audited
  `allow:ask:*` decisions, not a parallel path.

## 4. Test / DoD gates

- Headless `npm run build/test/lint/typecheck` green with OpenTUI uninstalled.
- Bridge: Esc/timeout/unmount resolves `no`; abort parity headless-vs-TUI.
- Redaction: seeded secret never appears in any rendered region or ring dump.
- Persistence: `--tui` run without `--continue` creates no session file; with
  `--continue` exactly one file via existing writer; audit `--verify` 100%.
- Perf: 500ms poll, tail-only render, no unbounded growth (ring cap asserted).
- A11y: `--no-tui` + 80-col output readable by screen reader; no-mouse op.

## 5. Ordered build steps

1. `src/tui/bridge` (approval-as-promise + `onEvent` tail subscription).
2. `src/tui/model` (in-memory ring + meter counters, caps asserted).
3. `src/tui/view` (5 regions + cards + composer + footer + keymap).
4. `--tui` / `--no-tui` flags + lazy import + isolated tsconfig/JSX.
5. Diff-preview-from-`captureBefore` (~15 lines) + rollback footer.
6. Slash commands (`/model /free /plan /rollback /sessions`) on existing CLIs.
7. Background pinned cards at 500ms poll.
8. Gates: absent-pkg build, redaction sweep, persistence, abort-parity, 80-col.

## 6. Open questions ONLY the user can answer (max 6)

1. **Ship the spike at all, given background > TUI priority?** Default: YES as
   flag-gated spike, zero headless regression allowed.
2. **OpenTUI as optional dep (approved) vs vendored minimal renderer?**
   Default: optional lazy dep; vendor only if install pain appears.
3. **Pilot trigger metric to graduate `--tui` from spike?** Default: ≥4–5
   trusted runs/team/week through TUI with zero bypasses + `audit --verify`
   100% over 2 weeks.
4. **Diff preview length (~15) acceptable vs zero-preview purist v1?**
   Default: keep ~15 from `captureBefore`; full viewer stays killed.
5. **Queue: hold zero-queue line vs allow Norman's one-item buffer?**
   Default: zero in v1; one-item needs a reopen ruling with pilot evidence.
6. **Rollback picker: plain-sentence picker now vs footer+command only?**
   Default: footer + `rollback <id>` only; picker is H2.
