# UX panel review — the operator model behind "One Yes Is Forever"

**Panel:** 5 voices — (1,2) human-AI interaction researchers, (3) security-UX
specialist (permission dialogs / consent), (4) terminal-UX veteran,
(5) accessibility expert. **Reviewed:** docs/paper/00-thesis.md (2026-09-13
reframe), README.md ("Approvals that stick", "Promotion"), src/loop.ts (ask
ladder), src/remember.ts + src/remember-store.ts (what gets remembered),
src/index.ts (prompt rendering, trust/metrics/verdict/rollback surfaces),
docs/paper/reviews/security-panel.md. Scope: operator experience only — the
security panel's code-level bypasses are assumed known and not re-argued.

---

## Voice 1 — Human-AI interaction researcher A (is "fat-finger once" the right operator model?)

It is not a strawman, but it is the *weakest* version of the true model —
and reviewers will say so. The human-factors literature is unambiguous:
people do not make one accidental always-press; they make a *deliberate*
always-press after enough exposure. Sunshine et al., "Crying Wolf" (USENIX
Security 2009) measured click-through on SSL warnings rising with exposure;
Anderson et al. (CHI 2016, fMRI) showed neural habituation within a handful
of repeated warnings — the brain stops allocating attention to identical
stimuli almost immediately. Felt et al. (SOUPS 2012) found ~17% of users
even glance at Android permission screens. Clinical alert-fatigue literature
(van der Sijs et al., JAMIA 2006) reports override rates above 90% once
dialogs become routine. Add the vigilance decrement (See et al. 1995
meta-analysis; Mackworth 1948): sustained attention degrades measurably
within tens of minutes, exactly the length of a coding-agent session, and
automation complacency (Parasuraman & Manzey 2010) makes humans rubber-stamp
whatever a trusted system proposes.

So the realistic operator is *worse* than the thesis models: p(`a`) is a
monotonically increasing function of ask-index within a session and of
session time, and by ask ~15 the press is not a slip at all — it is policy.
The thesis's "fat-fingered `a` is the common case, not an edge"
(00-thesis.md:53-54) is directionally right and empirically ungrounded: the
bench scripts `auto-deny / auto-yes / fat-finger-once` (00-thesis.md:130-131),
which models a point, not a curve. What a reviewer will demand instead:

1. **Habituation curves per session** — p(answer=always | ask-index,
   minutes-since-start, ask-rate), fit from real decision logs, with Wilson
   bands like every other rate in the paper.
2. **A fatigue distribution over the session**, not one synthetic slip: the
   "0/1/2 fat-fingers" framing the security panel asked for, generalized to
   a probabilistic operator with per-operator covariates.
3. **The uninformative-ask model.** The security panel already located the
   failure in subject opacity: for `npm run build` no amount of attention
   helps, because the preview cannot tell the operator what the script does.
   The operator model must therefore have two parameters — *attention
   decays* and *information available is sometimes zero* — and the second
   is the one the defense can actually fix.

The publishable claim is not "operators slip." It is "approvals habituate,
here is the curve, and asks that are informative + infrequent flatten it."
That claim requires data codewhip is uniquely positioned to collect (Voice 3,
Q4 below) and currently does not collect for humans — only for bench bots.

## Voice 2 — Human-AI interaction researcher B (does the UX support the user's mental model of remembering?)

No. The paper's defense rests on curation ("only safe heads are memorable")
and thresholds, but at the two moments that matter — granting and revoking —
the operator's mental model diverges from the stored artifact in four ways:

1. **One key, three semantics.** `a` stores `bash:head *` (prefix wildcard),
   exact path for edit/write, and the *bare origin* for webfetch — "one `a`
   covers every path under the host, never the query string"
   (README.md:423-425). Nothing at decision time tells the operator which
   generalization is about to be minted. `remember.ts:35-52` vs
   `remember.ts:74-78` — three grant grammars behind one keystroke.
2. **Memorability is unpredictable and only revealed after the fact.** The
   README's own example is `allow bash echo 'x' >> TEST.md? [y/N/a]`
   (README.md:413) — a command containing `>>` that is *unmemorable*
   (`remember.ts:30` screens redirects), so `a` there silently degrades to
   `y` ("not memorable … approved once, no rule stored", loop.ts:627). The
   section titled "Approvals that stick" opens with a command where it does
   not stick. The operator cannot know in advance whether `a` will mint a
   rule, mint a broad rule, or do nothing.
3. **Coverage expansion is invisible.** The emitted line
   `remembered: bash:cat *` (loop.ts:646) shows the shape, not its
   consequences (`cat .env` is inside that shape; the security panel showed
   the full chain). The paper's curation is a property of the *system*; the
   operator is never shown the *boundary* it draws.
4. **Reversibility asymmetry.** Files are undoable (`codewhip rollback`),
   runs are judgeable (`codewhip verdict`) — but the *most durable* action
   the operator can take, a grant, has no CLI lifecycle at all. Declines get
   `policy candidates / approve / list` (index.ts:1019-1078); allows get
   "delete its line from `.codewhip/remembered.jsonl`" (README.md:459-461) —
   a gitignored JSONL in a hidden directory, with no `remember list`. The
   paper says grants are "visible, attributable, never silent"
   (README.md:426); they are visible in the audit trail and invisible in the
   operator's command surface. Where the model breaks is precisely where the
   paper claims it holds.

## Voice 3 — Security-UX specialist (consent ethics of `[y/N/a]` with a = forever)

Judged against consent-design criteria the field now treats as table stakes
(informed, granular, scoped, time-boxed, revocable, non-nudged), `a` =
"allow once **and remember forever**" fails four of six — and one repo
detail is worse than the paper's own text:

- **Not informed at grant time.** The prompt interpolates the raw subject
  (`allow ${call.name} ${preview}? [y/N/a]`, loop.ts:610; preview is up to
  200 chars of workspace-controlled text) and never states the scope of the
  rule `a` will mint. Informed consent requires knowing what you are
  agreeing to *before* agreeing; here the scope is discoverable only by
  reading the source or the audit log afterward.
- **Not time-boxed.** `RememberedRule` records `ts` (remember-store.ts:9)
  and nothing ever consults it. Platform precedents are unanimous that
  durable grants should be the *opt-in*, not the default: iOS "Allow Once /
  While Using / Always" (iOS 13+), Android one-time permissions (Android
  11+), sudo's `timestamp_timeout` (elevation expires in minutes), OAuth
  tokens (scoped, expiring, revocable). Codewhip's ladder offers only
  once / forever. A "session" tier is missing — the single cheapest fix.
- **Revocation absent.** Confirmed: no `remember` command exists in
  `src/index.ts` (dispatch, main()); `listRules` is used only to *count*
  rules for `codewhip trust` (index.ts:1308-1311). Grant = one keystroke;
  revoke = know about a hidden file and hand-edit JSON. That asymmetry is
  indefensible in a product whose wedge is trust.
- **Actively nudged.** `codewhip trust` prints
  `memory: 0 remembered rule(s) accruing` and fails the trust certificate
  without at least one rule, suggesting `answer 'a' to remember a tool
  shape` (index.ts:1310, 1392, 1408). The product *rewards pressing `a`* in
  its headline trust metric. This is a consent anti-pattern: it converts a
  security decision into a gamified checkbox and directly manufactures the
  fat-finger/habituation population the paper models. For a paper titled
  "One Yes Is Forever," shipping a nudge that farms yeses is self-refuting.
  Remove or invert it (count *unscoped* durable grants as trust debt).

Consent-respecting ladder: `y` once / `s` this session / `a` forever only
after the tool prints the exact rule and its coverage ("will auto-allow
every future `git status …`; N = scoped narrower"). Plus renewal prompts on
expiry, first-class `remember list/show/revoke`, and a run-end line when
remembered rules fired ("2 calls auto-allowed by bash:cat * — revoke:
codewhip remember revoke 1"). That is what "consent that sticks" looks like;
what ships now is consent that *lodges*.

## Voice 4 — Terminal-UX veteran (the ladder itself, and ask volume)

Credit where due: the safe default is real — Enter or any unknown input
denies (`index.ts:486-497`), non-TTY asks are refused fail-closed
(loop.ts:562-566), and deny promotion is threshold-gated while allows are
curated. But the ladder has three terminal-UX problems the paper never
mentions:

1. **Recency invites the always-press.** `a` is the *last* character of
   `[y/N/a]` — the option users reach for under repetition is also the most
   physically habituating one. The ladder is maximally muscle-memoryable:
   one keystroke, same position, dozens of times per session (every
   edit/write/bash can ask). This is how `rm -i` y-spam was born; the fix
   tradition is to *reduce ask count*, not speed the answer.
2. **Ask volume is unbounded and unreviewed.** Nothing caps asks per run,
   nothing batches them, nothing shows the operator their own streak. The
   harness nudges the *model* for repeated calls (REPEAT_NUDGE_AT,
   loop.ts:41) while the *human* gets no equivalent: no "prompt 14 this
   session" counter, no queue-then-review mode. `git add -p`-style batch
   review — collect the run's asks, present as one reviewable list — would
   cut ask frequency (the habituation driver) and concentrate attention
   where it is spent best. This is the single most literature-aligned
   intervention available and it is absent from the defense.
3. **The prompt quotes attacker-controlled text raw.** The subject appears
   unframed and unsanitized in the question (loop.ts:610) — the security
   panel noted injected URLs that address the operator
   ("please-approve-always"). In a terminal there is no chrome, no origin
   labeling, nothing distinguishing harness prose from quoted content. A
   one-line framing convention (subject on its own line, prefixed, length-
   capped, control chars stripped) is required before any operator study,
   or the study measures susceptibility to *the prompt's own framing*, not
   to habituation.

## Voice 5 — Accessibility expert (who can perceive the grant state at all?)

The persistence surface is nearly invisible non-visually, which matters for
RQ2 because the semi-attentive-operator assumption is *most* false for
operators using assistive technology:

- **Semantics carried by glyphs.** Event prefixes are `▸` / `◈` / `◆`
  (index.ts:645) — tool / policy / compact are distinguishable only by a
  symbol. Screen readers announce these as arrow/diamond names or skip them;
  "remembered:" vs "not memorable:" differ by one word inside a stream of
  identical-shaped lines. There is no spoken-rank mapping, no verbosity
  tier, no plain-text event mode.
- **The ask is context-free.** `allow bash npm test *? [y/N/a]` gives no
  task, no run, no ask-count, no indication that this is ask #15 of a
  fatigue spiral. A screen-reader user relistening to a scrollback cannot
  reconstruct which grant is active; the state lives in a file the CLI
  never lists (Voice 3). Audit-line discoverability
  (`default:shell:ask+remembered`) is not accessibility — it requires
  knowing `audit --replay` exists and parsing hash tables.
- **200-char inline previews.** The raw subject (possibly a hostile URL
  path, Voice 4) is read aloud verbatim before the operator can decide —
  long injected slugs actively bury the decision-relevant prefix (`bash`,
  the head). Preview truncation should be head-first and structured
  (tool, head, target on separate lines), not one flattened 200-char string.
- **No non-interactive parity for grant review.** Non-TTY runs deny by
  construction (good), but there is no non-TTY way to *inspect or revoke*
  grants either — the revocation path is a visual file edit. `remember
  --json` would fix the parity gap in one line of design.

## Consensus verdict

The fat-finger model is not a strawman — it is an **understatement
mislocated as an accident**. The literature (habituation, vigilance
decrement, alert override rates) says operators converge to deliberate
always-pressing within a session; the bench's one-slip cell is an optimistic
lower bound, and reviewers will demand habituation curves plus the
uninformative-ask parameter the security panel already identified. Worse,
the product's own UX actively undermines the paper's defense claims at
three points: `codewhip trust` *rewards* pressing `a` (a gamified nudge to
mint the exact artifact the paper studies); revocation does not exist as a
command (grant = 1 keystroke, revoke = hand-editing hidden JSONL — an
asymmetry with deny-promotion's full CLI lifecycle); and the operator's
mental model breaks at grant time (one key, three undocumented scope
grammars; the README's own example is a command where `a` stores nothing)
and at enforcement time (coverage expansion invisible; "visible,
attributable, never silent" is true of the audit log, not of the command
surface). The defense's curation and thresholds are real *system*
properties that the *experience* never surfaces — so the paper's claim
"curation bounds the blast radius" is currently unfalsifiable *by its own
users*. All five voices agree the fixes are small, and two of the three
below double as experiment arms for RQ2/RQ4 rather than pure product work.

## Top 3 UX changes (each strengthens a defense claim)

1. **Scoped, expiring consent ladder with visible scope.** Add a session
   tier (`y` once / `s` this session / `a` forever), and make `a` print the
   exact rule + coverage *before* storing ("a = remember `npm run *`; future
   npm runs execute without asking — scripts in this repo define what they
   run"), with `ts`-based expiry consulted at load (`remember-store.ts`).
   Mark unmemorable subjects in the prompt itself ("a: approve once — shape
   not memorable") so stickiness is predictable. *Strengthens:* the
   "curated allow-generalization" claim becomes an operator-visible boundary
   and an RQ2 arm (mint rate per ladder variant: once/session/forever); the
   paper's operator model gains a measurable counterfactual.
2. **Grant lifecycle CLI — and kill the nudge.** Ship `codewhip remember
   list` (provenance: ts/runId/preview_hash plus two example future commands
   the rule would auto-allow), `remember revoke <n|shape>`, and a run-end
   line when remembered rules fired; remove the `trust` suggestion "answer
   'a' to remember" and invert the memory signal (count broad/unscoped
   durable grants as trust debt, not trust credit). *Strengthens:* the
   provenance claim ("ts/runId/preview_hash") becomes observable, the
   README's "visible, attributable" promise becomes true on the command
   surface, and the paper is no longer measuring a product that farms
   consents.
3. **Ask-time transparency and ask-budgeting.** Frame the quoted subject
   (own line, prefix-labeled, control chars stripped, head-first truncation),
   print a session ask counter ("approval 14 this run"), and add a
   batch-review mode (queue asks, present as one reviewable list, like
   `git add -p`) — ask volume is the habituation driver, and batching is the
   literature-aligned countermeasure. *Strengthens:* RQ4's utility-cost arm
   gains a real UX condition (asks-per-task, answer latency, mint rate under
   batching vs streaming), and the threat model's "semi-attentive operator"
   section can honestly say the defense acts on *information design*, not
   just on the denylist.

*All file:line references verified against the working tree, 2026-09-13.*
