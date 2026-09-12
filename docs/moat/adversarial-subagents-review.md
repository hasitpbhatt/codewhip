# Adversarial review — subagents & delegation (commit b16dd96)

Reviewer stance: Sutskever's "what breaks at scale" — probe the invariants, not the happy path.
Scope: `src/subagents.ts`, `src/tools/delegate.ts`, `src/tools/delegate_many.ts`, `src/loop.ts`,
`src/policy.ts`, `src/tools/registry.ts`, `src/audit.ts`, `src/checkpoints.ts`, plus the
supporting files each surface forced open (`jail.ts`, `provider.ts`, `outcomes.ts`, `compact.ts`,
`remember-store.ts`, `remember.ts`, `webfetch.ts`, `index.ts`, `pack.ts`).

Verdict up front: the depth guard and signal propagation are genuinely solid (independent,
fail-closed layers). The two real breaks are **cost integrity** (children run with no token
budget and the budget check is post-hoc per provider call) and the **cross-process audit lock**
(stale-lock steal forks the chain; contention silently drops entries). One medium injection
pivot via inherited remembered webfetch grants. Free-tier fan-out is a reliability gap, not a
security one.

---

## Surface 1 — Recursive depth via per-agent files

**Holds.** Depth > 1 is unreachable through any shipped path. Five independent layers:

1. `subagents.ts:195-197` — `runChildAgent` refuses when `depth + 1 > MAX_DELEGATION_DEPTH` (cap 1).
2. `delegate.ts:52-54` / `delegate_many.ts:69-71` — same check against `ctx.depth` at the tool layer.
3. `loop.ts:488-494` — pre-ladder refusal: any child (`isChild`) calling delegate fails closed even
   though `lookupTool` (loop.ts:126-131) still resolves the def for a hallucinated call.
4. `loop.ts:498-507` — plan-mode refusal; children are *always* planMode (`subagents.ts:209`), so
   edit/write/bash/delegate are refused before the permission ladder and remembered rules can
   never grant them.
5. `registry.ts:185-188` — `toolSpecs(depth > 0)` returns only `[read, search, webfetch]`; delegate
   specs are never advertised to children.

A file named X overriding a builtin only replaces `description`/`systemPrompt`/`maxSteps`/`model`
(`subagents.ts:143,160`) — nothing in the override reaches `depth`, which is carried structurally
in `LoopArgs`. Agent files referencing each other is a prompt-level fiction; the harness doesn't care.

### F1a — TOCTOU on agent definitions (Low, not exploitable cross-trust-boundary)
`findAgent` → `listAgents` re-reads `.codewhip/agents/` from disk on **every** delegate call
(`subagents.ts:147-154`; call sites `delegate.ts:55`, `delegate_many.ts:81`) while the roster in the
parent's system message was built once at run start (`loop.ts:230-235`). An agent file swapped
mid-run changes the child's system prompt (and `max_steps`, up to 25) with no re-consent, and the
roster the parent "saw" is stale. Requires write access to `.codewhip/agents` — i.e. the user, a
malicious checkout, or an already-approved write. `pack pull` **cannot** install agent files
(`pack.ts:69` writes `policy.md` only) — the distribution vector is closed. Low.

### F1b — Unbounded agent body and unbounded roster (Low-Med, cost DoS)
`parseAgentFile` has no size cap: the whole file is read (`subagents.ts:154`) and its body becomes
the child system prompt verbatim (`subagents.ts:134`). A multi-MB `explore.md` override rides in
**every child turn**; compaction protects system messages (`compact.ts:54`), so the transcript is
permanently over `DEFAULT_COMPACT_TOKENS` and each of up to 25 child steps re-sends the body —
cost amplifier plus provider 400s. Same class: no cap on the *number* of agent files, so the
parent roster (`loop.ts:233-234`) is unbounded in aggregate. `MAX_TASK_CHARS` (delegate.ts:17)
caps only the task. Fix: cap body bytes (e.g. 16k chars) and roster entries at parse time.

---

## Surface 2 — Token-budget bypass

**Broken, in a specific and quantifiable way.** The claim at `loop.ts:300-302` — "delegation
spends the parent's budget honestly … never off-book" — is true for *metering* and false for
*enforcement*.

Mechanics verified:
- The budget check runs **once per provider call**, after `addUsage` (`loop.ts:438-443`).
- `foldChildUsage` (`loop.ts:303-317`, wired at `loop.ts:645`) fires from `delegate.ts:73` /
  `delegate_many.ts:106` **after** each child finishes. So child tokens *do* reach `promptTokens`
  and are tested at the *next* turn's check — never earlier, and never during a turn.
- **Children inherit no budget at all**: `childArgs` (`subagents.ts:198-215`) omits `tokenBudget`
  and `compactTokens`. A child run is entirely unbudgeted.
- All tool calls of one assistant turn execute in a single loop (`loop.ts:453-677`) with **no
  budget check between them**.

### F2a — One turn can overshoot the run budget ~24× (High, exploitable in practice)
Worst case inside a single parent turn: `delegate_many` (4 concurrent children, `delegate_many.ts:87-101`)
with agent files at `max_steps: 25` (`CHILD_MAX_STEPS_CAP`), each step re-sending a compact-capped
~60k est.-token transcript (`compact.ts:20`) ≈ **6M est. tokens** against the default 250k budget
(`index.ts:276`). Sequential `delegate` calls in the same turn multiply further with no check
until the turn's provider call returns. On a paid provider that is real money; on free tiers it
is quota burn. Exploitability: no malice needed — a weak model that confuses delegate with search
and repeats it is the documented failure mode this repo already nudge-guards for read/search. The
`--token-budget` promise in `index.ts:68` ("max prompt+completion tokens for the run; enforced
mid-run") is not held for delegation. Fix: pass a remaining-budget into `childArgs`; check the
budget inside the tool-call loop before each exec; make `foldChildUsage` abort in-flight children
when the live counter crosses the ceiling.

### F2b — Repeat guard deliberately excludes delegate (Low, amplifies F2a)
`IDEMPOTENT_TOOLS` = read/search/webfetch (`loop.ts:39`); delegate is not memoized and the
`REPEAT_NUDGE_AT` nudge (`loop.ts:613-626`) never fires for it. Ten identical `delegate` calls in
one turn re-execute ten full child runs. The workspace-idempotence argument doesn't apply, but
delegate is a *pure cost multiplier* with workspace-identical results — it deserves the nudge or
a run-scoped dedupe on `(agent, task)`.

### F2c — Late fold after delegate timeout under-counts the parent receipt (Low, race-dependent)
`withTimeout` resolves the race with the fallback but the losing promise keeps running
(`loop.ts:164-174`). When the orphaned child eventually settles, `delegate.ts:73` calls
`ctx.onChildUsage` — mutating the parent's counters **after** the parent may already have written
its outcome record (`loop.ts:680-693`) and printed the receipt. The spend is captured in the
child's own outcome record, so the ledger is complete across the two files — but the parent's
"honest receipt" for that run can under-count. The parent's audit entry for the timed-out call
records the *fallback text* hash and never records the child runId (`delegate.ts:77` appends it
only on success) — the two records are linked only by timestamp archaeology.

---

## Surface 3 — Audit-chain contention under Promise.all children

**Intra-process: safe.** `appendEntry` (`audit.ts:125-182`) is fully synchronous — mkdir lock,
full-log read, sign, `openSync`/write/fsync, rmdir — with **no await point**. Node serializes
synchronous sections across "concurrent" children, so Promise.all fan-out cannot interleave
entries, fork `seq`, or drop entries *within one process*. The mkdir lock exists for
cross-process contention only, and that is where it fails.

### F3a — Stale-lock steal forks the chain (Medium, cross-process, rare but real)
A waiter removes the lock dir when its mtime is older than 5s (`audit.ts:139-141`). The critical
section is O(chain): `readAuditLog` parses the **entire** audit.log per append (`audit.ts:145`)
plus ed25519 signing plus fsync. On a long-lived repo (multi-MB log, slow disk, AV scanning on
win32) a holder can exceed 5s; a second process steals the lock, both read the same tail, and both
append with the same `seq` and `prev_hash`. `verifyChain` then reports `seq mismatch` /
`prev_hash does not chain` (`audit.ts:243-248`) — the chain reads **BROKEN** (tamper-evident doing
its job, now falsely crying tampering). Entries are not lost, but the validity claim is. Needs two
concurrent codewhip processes in one checkout (CI + local dev on the same repo) — plausible at
scale, rare per run.

### F3b — Silent entry drop under sustained contention (Medium-Low)
Lock acquisition gives up after 50 tries × 10-30ms ≈ 1.25s and returns `false` (`audit.ts:128-134`).
The loop call site ignores the return value entirely (`loop.ts:466-475`,
`try { appendEntry(...) } catch {}`). Under cross-process contention > 1.25s, entries vanish with
no trace, no counter, no warning. The chain stays *verifiable* (the next entry chains from the
actual tail) but the completeness claim — the whole point of per-child auditable calls — silently
degrades. A dropped child deny is indistinguishable from a call that never happened. Fix: count
drops in the run receipt at minimum; better, extend the retry window and fail loudly on
`false` from a child's deny path.

### F3c — O(chain) per append is quadratic under fan-out (Info)
4 children × 25 steps on a 10k-entry log ≈ 1,000 full-file parses+re-signs per run
(`audit.ts:145`). Perf, not correctness — but it is what makes the F3a steal window grow over time.

`checkpoints.ts` is not reachable from children (edit/write refused pre-ladder) and its
verify-everything-then-apply rollback (`checkpoints.ts:129-146`) is unaffected by fan-out. No findings.

---

## Surface 4 — Prompt injection into children

What holds, verified:
- The signing key is genuinely protected: `read` refuses `.codewhip/key` by real-path segment
  check (`jail.ts:46-49`, applied at `read.ts:44-46`), including via symlink (jail realpath
  resolution, `jail.ts:19-29`). `.env*`, `*.pem`, `*.key`, `credentials.json` refused by basename
  (`jail.ts:36`, `read.ts:41-43`). `search` skips `.codewhip` entirely (`search.ts:10,33`).
- Children cannot ask: no `askUser`, `stdinIsTTY: false` (`subagents.ts:204-205`) → every ask-class
  call auto-denies (`loop.ts:525-530`). Children cannot *create* remembered rules — `persistRule`
  lives only inside the interactive ask branch (`loop.ts:588`).
- Plan-mode refusal precedes the ladder, so remembered shapes can never grant edit/write/bash to a
  child (`loop.ts:498-507`).
- Child reports return redacted (`redactSecrets`, `loop.ts:666-674`) and capped at 4,000 chars
  (`loop.ts:202,673`).

### F4a — Inherited remembered webfetch grants = non-interactive exfil pivot (Medium)
`runChildAgent` passes `remembered: listRules(cwd)` (`subagents.ts:210`). A child calling webfetch
on a previously `a`-approved origin matches the stored shape (`loop.ts:545-553`) and **proceeds
with no human gate**. So an agent-file body (raw, unsanitized, `subagents.ts:134`) — or an
8,000-char task string authored by the parent model, itself steerable by webfetched content — can
direct children to send workspace-derived text to any origin the human ever said "always" to. The
exfil channel is the URL, which is sent verbatim (`webfetch.ts:93`) and never redacted;
`redactSecrets` scrubs only what flows back, and it is explicitly best-effort
(`redact.ts` comments). The child's audit line says `ok webfetch` with an origin-only preview —
one line lost in a 4-wide fan-out, non-interactive, nothing live for the human to see.

Honest framing: the *parent* can do exactly the same thing, so this grants no new authority —
but delegation adds a masked, parallel channel and puts the grant use at one remove from the
human. Exploitable in practice when (a) a malicious agent file exists (only writers: the user or
repo contents — packs can't carry agents), or (b) indirect injection through webfetched content
convinces the parent to delegate a task like "check if this config value is reachable at
https://<approved-origin>/…". Fix: children inherit remembered *read-class* rules only — strip
webfetch (and bash) rules from `listRules` output in `runChildAgent`, or require webfetch in a
child to re-ask via the parent.

### F4b — "Read refuses secret material" is only true for the key and .env-class files (Low)
`read .codewhip/remembered.jsonl`, `audit.log`, `outcomes.jsonl`, `key.pub`, `checkpoints/**` all
**succeed**: basename-based refusals (`read.ts:41-46`) don't cover harness state. Content is
low-sensitivity (shapes, hashes, redacted previews) — but `remember.ts:16` still claims "The model
never sees these lines", which is now false for parents and children alike. An injected child can
read the repo's full policy posture (rule shapes, promoted denies). Metadata disclosure, not key
material. Fix: extend `isPrivateKeyPath` into a `.codewhip/**` read refusal (read-only harness
state has no reason to enter any transcript) — or fix the comment.

### F4c — Roster descriptions are prompt-injection surface into the parent (Info)
Agent descriptions (≤200 chars each, `subagents.ts:111`) are concatenated into the parent's system
message unsanitized (`loop.ts:230-235`). Bounded per agent, unbounded in aggregate (see F1b). The
depth/policy guards hold regardless — this burns parent attention, not authority.

---

## Surface 5 — Signal propagation

**Works.** Traced end to end: `withTimeout`'s internal controller aborts at 600s or on outer abort
(`loop.ts:149-179`) → `runDelegate` signal → `childArgs.signal` (`subagents.ts:208`) → the child's
provider calls pass `signal: args.signal` (`loop.ts:356`) → `openAiPort` registers an abort
listener and aborts the fetch (`provider.ts:949-953`, fetch at `:991`) → classified "cancelled"
(`provider.ts:993-994`) → child loop breaks cleanly (`loop.ts:366-368`) and still writes its own
honest outcome record. SIGINT rides the same path (`index.ts:611-615`). Child webfetch honors the
outer signal (`webfetch.ts:90-91,121-124`). Read/search are synchronous and uninterruptible —
bounded (10s tool cap, scan budgets), documented (`loop.ts:147-148`). The answer to the surface
question is **yes**: the 600s delegate timeout does cancel the child's provider calls.

Residual gaps are F2c (late fold, missing runId linkage on the timeout path) plus:

### F5b — Shared 600s across the fan-out (Info, by design)
`delegate_many`'s timeout is tool-level: one clock for all 4 children (`delegate_many.ts:123`,
`DELEGATE_TIMEOUT_MS`). One slow child aborts the shared signal, so the other three get
`[subagent cancelled]` prefixes (`subagents.ts:224`). Correct, but a run budgeted at 600s per
child silently becomes 600s total — worth a line in the tool description.

---

## Surface 6 — Free-tier parallelism

### F6a — Children inherit no rotation; delegate_many = a designed 429 storm (Medium, reliability)
`childArgs` (`subagents.ts:198-215`) omits `models`, `failovers`, and `retryWait`. So in a child:
`tried = {model}` (`loop.ts:275`), no rotation candidates (`loop.ts:404` evaluates `args.models`
→ undefined), no chain, no wait — the **first 429 kills the child** with its steps' tokens burned
and zero retries. Rotation does *not* help inside children; it is a parent-loop feature that is
simply not forwarded. `delegate_many` fires 4 children **concurrently on the same port** (same
provider, same model, same IP) plus the parent's own next call = 5 in flight. Against the shipped
catalog this is a guaranteed failure, not a risk: fabryka's own row says "single-GPU backend: keep
concurrency at 1, concurrent requests fail" (`provider.ts:218`); pollinations is "~1 req/s
per-IP" (`provider.ts:350`); nvidia free tier ~40 req/min (`provider.ts:134`). The tool is
unusable-as-shipped on concurrency-1 providers and quota-wasteful everywhere else on free tiers —
and the waste lands unbudgeted (F2a). Fix: inherit the parent's rotation chain (bounded), or
serialize children per provider label with small stagger, or cap fan-out to 1 for providers whose
config declares a concurrency limit (the `rateLimitedHint` already encodes this for fabryka —
make it a field).

---

## Extra observations

- **E1 (Info)** — `delegate_many` returns `ok: failed < runs.length` (`delegate_many.ts:117`): a
  4-child fan-out with 3 failures reports `ok: true`. The parent model must parse prose lines to
  notice. Return `ok` only when all succeed, or expose the count structurally.
- **E2 (verified sound)** — the depth belt at `loop.ts:488-494` correctly fails closed for
  non-advertised tools; `toolSpecs` filtering is construction-time only, and the belt covers the gap.
- **E3 (Info)** — agent name parsing is solid: `NAME_RX` (`subagents.ts:79`), CRLF-tolerant
  frontmatter close (`subagents.ts:96`), invalid files skipped with reasons, directories named
  `*.md` fail the read and are skipped (`subagents.ts:153-156`).

---

## What actually holds (credit where due)

1. Depth: five independent fail-closed layers; no shipped path constructs a depth-2 child.
2. Plan-mode refusal precedes the ladder — remembered rules and `--yolo` can never arm a child.
3. Signal propagation to provider calls is complete, including SIGINT and the 600s tool clock.
4. Intra-process audit integrity under fan-out is guaranteed by synchronous appendEntry — the
   concurrency surface the design *doesn't* handle is cross-process only.
5. The signing key, `.env*` class, and `.codewhip` (from search) are genuinely out of child reach;
   children cannot create remembered rules or reach an interactive approval.
6. Pack pull cannot distribute agent files.

## Priority fixes

1. **F2a**: propagate a remaining token budget into `childArgs`; check it per tool call, not per
   provider call; abort in-flight children on breach. (High)
2. **F3a/F3b**: fail loudly (or count) when `appendEntry` returns false; replace mtime-steal with a
   PID+heartbeat lock, or make the critical section O(1) by caching the tail. (Medium)
3. **F6a**: give children the parent's rotation chain or serialize per provider. (Medium)
4. **F4a**: strip webfetch rules from inherited `remembered` in `runChildAgent`. (Medium)
5. **F1b/F4b**: cap agent body bytes and roster size; extend the `.codewhip` read refusal to
   harness state (or fix the stale `remember.ts:16` claim). (Low)
