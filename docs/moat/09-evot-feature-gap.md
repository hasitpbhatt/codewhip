# 09 — Evot feature-gap review (five-lens, 2026-09-16)

Panel: naval-leverage, naval-memory, naval-governor, naval-scout, naval-synthesizer.
Method: read evot source at `github.com/evotai/evot` main (Rust engine+app, Bun TUI)
plus local `evot --help` v2026.9.16 — compared against codewhip `src/` at HEAD.
Features cited from code, not marketing.

## Evot inventory (verified in source)

- **Kernel sandbox**: Landlock LSM on Linux 5.13+ and Seatbelt on macOS,
  applied `pre_exec` in the child; allowlist-by-omission filesystem rules
  (`src/engine/src/tools/sandbox/`). Parent never restricted.
- **Background execution**: `bash` auto-hands long commands to a task manager
  after a foreground-wait window (600s default / 1800s cap, 256KB output);
  `run_in_background`, `task_output`, `task_stop` tools; ctrl+b manual
  backgrounding; completion notifications injected mid-run.
- **TUI**: full Bun/TS renderer — streaming markdown + LaTeX math, dark/light
  themes, diff view, model/session/skill selectors, queued messages while
  busy, scroll preview, plan-mode toggle, ad slot.
- **Compaction**: algorithmic + LLM summarizer + provider-native remote
  compaction (OpenAI Responses) + emergency tier + manual `/compact`.
- **Semantic search**: `search` tool builds a cached BM25 index per root,
  ranked hits with 8-line code previews (separate from glob/grep).
- **Skills**: `/skill install` from GitHub — official `evotai/evot-skills`
  registry + arbitrary `owner/repo@ref/path`, atomic staged installs,
  `.evot-source.json` provenance; builtin `harden`/`memory`; `--skills`,
  `--skill`, `--append-system-prompt`.
- **Hosted share**: `/share` → read-only link on evot.ai; `/share` import,
  list, notices.
- **Scheduled tasks**: `/task` → cloud cron (timezone, per-task
  model_policy/thinking_level, revision-tracked), lease/dispatcher/executor,
  push delivery to channels with delivery-status reporting + stats.
- **Gateway channels**: Feishu bot over websocket (credential-setup flow,
  chat targets, token mgmt) + HTTP dashboard (`serve`, axum+ws).
- **Sessions**: search, favorites, auto-titles, replay, ephemeral readonly
  `fork` (log-analysis mode), `--resume/--continue`.
- **Host tools**: `ask_user` (structured options mid-run), `plan`.
- **Tool modes**: Interactive / Headless / Planning / Readonly presets.
- **Models**: catalog with capabilities + thinking levels + overrides;
  anthropic / openai_compat / openai_responses / bedrock protocols; comma-list
  multi-model; hosted `evot login` → free sponsored frontier tokens.
- **Misc**: image reads (png/jpeg/gif/webp + resize), headless-Chrome
  webfetch (optional), `--output-format stream-json`, `-f` context attach,
  doom-loop guard, jsonrepair on malformed tool calls, large-output spill to
  fs, self-update, single static binary via curl.
- **What evot does NOT have**: allow/ask/deny policy engine (5 hardcoded bash
  patterns only: `rm -rf /`, `mkfs`, `dd if=`, fork-bomb), no audit chain, no
  outcomes/verdicts, no per-run $ meter, no subagents, no checkpoints/rollback,
  no provider proxy, no packs/CI action. Governance = PathGuard + sandbox +
  mode presets. Accountability surface is zero.

---

## naval-leverage — execution per dollar

Ranked by $/task impact, not feature count:

1. **Background tasks — real gap, adopt.** Codewhip `bash` is foreground-only,
   120s cap, and `&`/chaining are *denied* — a long `npm test` or dev server
   blocks the loop or can't run at all. Evot's model overlaps independent work
   while shells run. For long-horizon tasks this is the difference between
   finishing and stalling. Ships cheap: process manager + two tool verbs +
   completion note appended as a tool result. Must write to audit.log like
   every tool call.
2. **BM25 search — adopt when grep hurts.** Grep walks are O(repo) per query;
   a cached index returns ranked hits with previews. Fewer wasted `read`s =
   cheaper tasks. Defer behind evidence (search-call count in outcomes).
3. **LLM-summarizer compaction — adopt over algorithmic when a cheap model
   exists.** Truncate+elide loses recall; evot runs three tiers incl.
   provider-native remote compaction. Codewhip already has the cheap-model
   router — polish-class models can summarize. Keep algorithmic as fallback
   (honest chars/4, no tokenizer dep).
4. **ask_user host tool — adopt.** One structured mid-run question prevents a
   wasted run; cheaper than a wrong guess at frontier prices. It is an audited
   tool call like any other.
5. **Spill-to-disk for large outputs — adopt.** 4-6KB truncation throws away
   evidence the model may need; evot spills to fs and returns a path.
6. **Kill**: TUI (headcount + kill-list), Feishu gateway, cloud-cron backend,
   headless Chrome (dep weight), hosted auth. `--json` already covers
   stream-json's CI use.

## naval-memory — compounding state

- **`/clip`-style vault = the deferred `memory.md` surface.** Evot shipped the
  durable-knowledge UX codewhip deferred behind the verdict signal. Their
  memory is unscoped, unaudited, unprovenanced — a diary. Ours must stay
  policy-scoped + hash-chained (Ruling 4 stands). The gap is *recall UX*, not
  trust. Still gated on verdict volume; do not pull forward.
- **Session search/favorites/titles — real but minor.** Codewhip sessions
  persist raw transcripts with no retrieval layer. Cheap adopt: `sessions
  search <q>` over the JSONL dir.
- **Scheduled tasks + push delivery = memory that accrues while you sleep** —
  literally the leverage thesis. But it needs a cloud backend or a local cron
  shim; note for H2, don't build the backend.
- **Skills = packaged specific knowledge** — the lark-*/opencli skills are
  domain know-how distributed as files. Our `.codewhip/agents/*.md` +
  packs cover the mechanism; what's missing is the *install path*
  (`pack pull` from GitHub, not just local copy).
- Not gaps: outcomes/verdicts/metrics/audit — we have them, evot has none.

## naval-governor — enforcement

- **THE gap: kernel sandbox.** Codewhip's bash protection is *string-matching*
  (`CHAIN_RX`, denylist, worktree-escape regex) — a determined command shape
  or a tool-chain the strings didn't foresee gets through; the file jail is
  realpath-solid but bash is regex-solid. Evot enforces at the kernel:
  Landlock allowlist-by-omission in the child, macOS Seatbelt. That is
  enforcement-grade — the exact word in our wedge. **Pull a local-OS sandbox
  tier forward from H2**: `landlock` on Linux / `sandbox-exec` profile on
  macOS behind the existing policy resolution; no microVM/E2B needed for v1.
  Strings stay as the deny layer; kernel handles the jail.
- Parity-ish: evot `PathGuard.restricted` ≈ our path jail (we're equal there).
- We still lead: allow/ask/deny rules, promotion-from-declines, remembered
  approvals, hash-chained signed audit, outcomes, verdicts, CI ask⇒deny.
  Evot's whole governance is 5 hardcoded patterns + mode presets. The
  *accountability* moat is intact; the *enforcement* claim is now behind.

## naval-scout — wedge and distribution

- **Hosted share link — the loudest gap.** `run --share` produces a
  gitignored local path; `/share` produces a URL anyone can open. Our P1
  "pasteable artifact" (`--share --print` markdown block) closes most of the
  demo gap without a server — ship that first; hosted links stay gated on a
  server we deliberately don't run yet.
- **Free sponsored frontier models at login** removes BYOK friction entirely;
  our `free` directory still asks for keys. Counter without subsidy:
  `codewhip free` + `--free` auto-pick is already the honest version — keep,
  don't chase their sponsor economics.
- **Single binary vs npm+node** — install friction gap for non-JS shops.
  Mitigate with `npx codewhip` quickstart; a bundled build is H2.
- **Cron + Feishu = agent-in-the-chat-where-teams-live.** Real distribution
  surface, but it's a hosted-cloud business; adopting the *local* half
  (a `run --cron`/systemd timer recipe + delivery via webhook) costs a doc,
  not a backend.
- **TUI** — kill-list holds, but note plainly: evot's TUI is its daily-driver
  surface and part of why it spreads. Our counter is not a TUI; it's the
  receipt + audit link being the artifact people screenshot. If pilot UX
  feedback says the REPL loses demos, revisit with a ruling, not a drive-by.
- **Non-clone guard**: evot is "the lightest harness" — it *cannot* add
  policy files, audit chains, or verdicts without betraying its positioning.
  Every feature we adopt must land behind policy + audit, or we become the
  clone.

## naval-synthesizer — rulings

**D1 — Sandbox: strings vs kernel.** Governor wins. Kernel-enforced FS
allowlist is the enforcement-grade claim the wedge makes; regex bash denial
is a safeguard, not a boundary. **Pull Landlock/Seatbelt-tier sandbox into
post-P1 work** — ahead of e2b/firecracker, which stay H2. *Cost-of-wrong:*
one jail escape in a pilot is unrecoverable; the port is ~200 lines + feature
detection, cheap to stage.

**D2 — Background tasks.** Leverage wins; Scout doesn't object (it's
execution, not breadth). **Adopt**: process manager + `run_in_background` +
`task_output`/`task_stop`, foreground-wait handoff, every transition audited.
*Cost-of-wrong:* codewhip can't run a dev server or 5-min test suite today —
that's table stakes, not scope creep.

**D3 — Compaction v2.** Memory+Levrage: LLM-summarizer tier on the polish
route, algorithmic stays default+fallback. **Adopt, sequenced after
background tasks.** Remote/provider-native compaction: defer (protocol
lock-in for marginal recall).

**D4 — Share.** Scout's pasteable `--share --print` ships next (already P1);
hosted links stay gated. **No cloud.**

**D5 — ask_user.** Adopt — audited structured question, TTY-only, headless
returns "cannot ask". *Cost-of-wrong if skipped:* silent wrong-guess runs.

**D6 — Skills/packs.** Memory's point lands: the gap is the *install path*,
not the concept. Extend `pack pull` to `owner/repo[@ref]` GitHub sources with
hash pinning — one feature, not an ecosystem. Reject a skills registry.

**Deferred (with triggers)**: BM25 search (when outcomes show search-call
dominance), session search/titles (when sessions >50/repo), LLM compaction
remote tier, local cron recipe (doc-only), TUI (only on pilot-feedback
ruling), Feishu/chat channel (H2, needs demand), image reads (when a pilot
asks), headless-chrome fetch (never — dep weight), stream-json (current
`--json` suffices), self-update (npm already does it), favorites/fork
(nice-to-have), ad slots (never — different business).

**Keep-as-wedge (evot can't follow)**: policy engine, audit chain,
outcomes+verdicts, $-metered receipts, subagents, checkpoints/rollback,
provider proxy, packs+CI.

## Ordered adoption list (proposed, needs rulings-log entries to land)

1. Background process system (audited task tools)
2. Kernel sandbox tier (Landlock + Seatbelt behind policy resolution)
3. `run --share --print` pasteable receipt
4. `ask_user` host tool (TTY; audited)
5. LLM-summarizer compaction tier on the cheap route
6. Large-output spill to `.codewhip/spill/`
7. `pack pull` from GitHub sources (hash-pinned)

Invariant for all seven: every adopted feature writes audit entries and
respects `codewhip-policy.yaml` — adoption must deposit trust, not spend it.
