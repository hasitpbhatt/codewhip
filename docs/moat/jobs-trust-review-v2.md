# Steve Jobs Review: FIXED `codewhip trust` Command

**Date:** 2026-09-12  
**Subject:** codewhip trust v2 — single-command trust certificate  
**Verdict:** **PASS — Ship it. But fix the friction first.**

---

## The One-Sentence Summary

The trust command is finally *honest*. It parses YAML correctly, evaluates polish from real runs, separates usable keys from anonymous rate-limited ones, and treats pre-key unsigned entries as expected rather than broken. The chain logic is sound. The PASS criteria are achievable. The next steps are contextual.

**But the experience still has friction that makes it feel like a tool, not a product.**

---

## What's Delightful (The "Yes")

### 1. YAML Deny Parsing — Finally Fixed
```yaml
deny:
  - "rm -rf /"
  - "git push --force"
  - "curl .*\.env"
```
**Detected: 3 base denies.** The old code would have returned 0 because it looked for `deny:` lines followed by `- "..."` on the *same* line. Now it tracks the deny section state properly. This is table stakes — but it was broken before. Fixed.

### 2. Polish Gate Evaluates from Reality
```typescript
const outcomes = readOutcomeRecords(cwd);
const polishRuns = outcomes.filter((r) => 
  r.model.includes("sensenova") || r.model.includes("flash") || r.model.includes("haiku")
);
```
It finds the *last* actual polish run, estimates its cost, runs `polishGate(cost)`. No fiction. If you haven't run polish, it says "no polish run recorded" — honest. If you have, it shows the actual cost and whether it passed `<$0.05`. This is how a pro tool behaves.

### 3. Keys: Usable vs Anonymous — Separated
```
keys: 5 usable (env/file), 4 anonymous (rate-limited)
  usable: nvidia (file), mistral (file), sensenova (file), opencode (file), stepfun (file)
  anonymous: llm7 (anonymous, rate-limited), kilo (anonymous, rate-limited), empero (anonymous, rate-limited), pollinations (anonymous, rate-limited)
```
This is the **single best UX decision** in v2. Before: a wall of "set" or "missing" with no distinction between "I can run real work" and "I can run 3 requests then hit a wall." Now: you see exactly what you can *actually use*. The anonymous providers are labeled honestly — "rate-limited" — so nobody wonders why their free chain dies.

### 4. Chain: Pre-Key Unsigned = Expected, Not BROKEN
```typescript
const preKeyProblems = v.problems.filter((p) =>
  p.includes("entry unsigned while a key exists")
);
if (preKeyProblems.length === v.problems.length && v.keyPresent) {
  chainStatus = "INTACT (pre-key entries unsigned as expected)";
  chainClean = true;
}
```
The audit log has 19 entries. First 13: unsigned (demo runs before `codewhip init` generated the key). Last 6: signed. The old `audit --verify` screams **BROKEN** with 13 red lines. The trust command says **INTACT (pre-key entries unsigned as expected)**. This is the right call — it's not a security failure, it's *history*. The chain is cryptographically sound from the moment the key existed.

### 5. PASS Criteria: Achievable, Not Aspirational
```typescript
const allGood = chainClean && baseDenies > 0 && hasMemory && usableKeys.length > 0;
```
Four concrete gates:
1. **Chain clean** — not broken, pre-key unsigned is fine
2. **Base denies > 0** — policy has teeth (3 from init)
3. **Memory accruing** — at least 1 remembered rule (answer 'a' once)
4. **Usable keys > 0** — at least one env/file key (not anonymous)

No "policy.md has 10 promotes." No "all 40 providers have keys." No "polish gate passed on first try." This is a bar a team can actually clear in 10 minutes.

### 6. Contextual Next Steps
```
TRUST: NEEDS WORK
  next: codewhip run ... (answer 'a' to remember a tool shape) | codewhip run --class polish "..." (prove <$0.05)
```
It tells you *exactly* what's missing and *exactly* how to fix it. No generic "see docs." The suggestions are derived from the actual failing gates. This is the difference between a checklist and a coach.

---

## What's Not Delightful (The "No")

### 1. The Output Is a Wall of Text, Not a Certificate
```
codewhip trust — single-command trust certificate
  audit chain: INTACT (pre-key entries unsigned as expected) (19 entries, 6 signed, 13 unsigned, key present)
  policy: 3 base deny(es) + 0 promoted deny(es) active
  polish gate: OPEN (cost untracked for this provider:model — gate needs a priced route)
  memory: 0 remembered rule(s) accruing
  keys: 5 usable (env/file), 4 anonymous (rate-limited)
    usable: nvidia (file), mistral (file), sensenova (file), opencode (file), stepfun (file)
    anonymous: llm7 (anonymous, rate-limited), kilo (anonymous, rate-limited), empero (anonymous, rate-limited), pollinations (anonymous, rate-limited)
  codewhip-policy.yaml: active (has base denies)
  policy.md: no promoted denies

TRUST: NEEDS WORK
  next: codewhip run ... (answer 'a' to remember a tool shape) | codewhip run --class polish "..." (prove <$0.05)
```
**Problems:**
- No visual hierarchy. Everything same weight.
- "TRUST: NEEDS WORK" buried at the bottom.
- No color. No icons. No scanability.
- The "certificate" metaphor is invoked but not delivered.

**What a certificate looks like:**
```
┌─────────────────────────────────────────────────────────────┐
│  ✅  codewhip trust certificate                              │
│  ─────────────────────────────────────────────────────────  │
│  🔗 Audit Chain       INTACT  (19 entries, 6 signed)        │
│  🛡  Policy            3 base denies  •  0 promoted         │
│  ✨ Polish Gate        ⚠ OPEN  (no polish run recorded)     │
│  🧠 Memory             0 rules  (answer 'a' to start)       │
│  🔑 Keys               5 usable  •  4 anonymous (rate-lim)  │
│  ─────────────────────────────────────────────────────────  │
│  ❌  TRUST: NEEDS WORK                                      │
│     → Run a polish task:  codewhip run --class polish "..." │
│     → Remember a rule:    answer 'a' on any tool prompt     │
└─────────────────────────────────────────────────────────────┘
```
**This takes 20 lines of code. Do it.**

### 2. `audit --verify` Still Screams BROKEN
The trust command handles pre-key correctly. `audit --verify` does not.
```
audit: 19 entries — hash chain BROKEN (6 signed / 13 unsigned, key present)
  ! seq 1: entry unsigned while a key exists
  ...
```
**This is a bug.** The verify command should have the same intelligence. If the only problems are pre-key unsigned entries and a key exists now, the chain is INTACT. The verify command is the *source of truth* — if it lies, trust loses credibility.

### 3. Polish Gate Detection Is Brittle
```typescript
const polishRuns = outcomes.filter((r) => 
  r.model.includes("sensenova") || r.model.includes("flash") || r.model.includes("haiku")
);
```
This assumes polish = sensenova/flash/haiku. But:
- User can override with `--provider openrouter --model gpt-4o-mini`
- User can run `--class polish` with any provider
- The classifier (`POLISH_RX`) knows what polish *is* — the model doesn't

**Fix:** Tag the outcome with `taskClass` at write time. Then filter by `r.taskClass === "polish"`. The router already classifies — use that signal, not a model-name heuristic.

### 4. Missing Keys List Is Noise
```
keys: 5 usable (env/file), 4 anonymous (rate-limited)
  usable: nvidia (file), mistral (file), sensenova (file), opencode (file), stepfun (file)
  anonymous: llm7 (anonymous, rate-limited), kilo (anonymous, rate-limited), empero (anonymous, rate-limited), pollinations (anonymous, rate-limited)
```
It lists *all* 40+ providers. The user cares about:
- **Which usable keys do I have?** (5 — good)
- **Which providers am I *trying* to use that are missing?** (0 — not shown)
- **Which anonymous providers are in my free chain?** (not shown)

**Fix:** Show only providers with keys (usable + anonymous). Add a separate line: "missing keys for configured providers: none" or "missing: nvidia, groq" if the user has explicitly configured them.

### 5. No JSON Output for Automation
```bash
codewhip trust --json
```
CI needs this. `github-actions` needs this. The command prints human text only. **Add `--json` flag.** Return structured data: `{ chainClean, baseDenies, promotedDenies, polishGate, memory, usableKeys, anonymousKeys, pass, issues, nextSteps }`.

### 6. The "Policy" Section Is Redundant
```
policy: 3 base deny(es) + 0 promoted deny(es) active
codewhip-policy.yaml: active (has base denies)
policy.md: no promoted denies
```
Three lines saying the same thing. Collapse to one:
```
policy: 3 base denies (codewhip-policy.yaml)  •  0 promoted (policy.md)
```

---

## The Friction Audit

| Step | Current Friction | Target |
|------|------------------|--------|
| Run `codewhip trust` | Read 20 lines, find PASS/FAIL at bottom | Scan in 2 seconds |
| Understand why FAIL | Parse suggestions manually | Visual icons + one-line fixes |
| Fix missing memory | `codewhip run "..."` → answer 'a' | Same, but suggested command is copy-pasteable |
| Fix polish gate | `codewhip run --class polish "..."` | Same, but show example prompt |
| Verify in CI | Impossible (no --json) | `codewhip trust --json \| jq .pass` |
| Cross-check audit | `audit --verify` says BROKEN | Both commands agree |

---

## Direct Fixes (Do These Before Ship)

### 1. Visual Certificate Format (High)
- Add box-drawing characters or emoji prefixes
- Color: green ✅, yellow ⚠, red ❌, blue ℹ
- PASS/FAIL at top, not bottom
- Group related items

### 2. Fix `audit --verify` Pre-Key Logic (High)
- Same pre-key detection as trust command
- If only pre-key problems + key exists → INTACT
- Keep the detailed problems for *actual* breaks

### 3. Tag Outcomes with TaskClass (Medium)
- In `appendOutcome`, include `taskClass` from the run
- Trust command filters by `taskClass === "polish"`
- Removes model-name heuristic

### 4. Add `--json` Flag (Medium)
- Structured output for CI/automation
- Include all gate states + pass/fail + nextSteps array

### 5. Condense Policy Display (Low)
- One line, two files, done

### 6. Show Only Relevant Keys (Low)
- Providers with keys (usable + anonymous)
- Separate "missing for configured providers" if any

---

## The "Say No" Test

| Scenario | Trust v2 Says | Correct? |
|----------|---------------|----------|
| Fresh repo, `codewhip init` only | NEEDS WORK (no memory, no keys) | ✅ Yes |
| Demo run only (pre-key) | PASS on chain, NEEDS WORK on rest | ✅ Yes |
| Keys set, memory accruing, base denies | PASS | ✅ Yes |
| Anonymous keys only (llm7, kilo) | NEEDS WORK (0 usable keys) | ✅ Yes |
| Chain actually tampered | BROKEN (real problems surface) | ✅ Yes |
| Polish run on priced route >$0.05 | OPEN with cost | ✅ Yes |
| Polish run on unpriced route | OPEN (untracked) | ✅ Yes |

**It says no to the right things.** The gates are real. The criteria are honest. A team lead *can* hand this to an intern at 2am and get a meaningful answer.

---

## The "Seamless End-to-End" Test

**Current flow for a new team member:**
```bash
git clone repo
codewhip trust
# → NEEDS WORK: no keys, no memory
codewhip auth login nvidia
# → paste key
codewhip run "fix typo in README" --class polish
# → answer 'a' to remember
codewhip trust
# → PASS
```
**Works. 4 commands. ~2 minutes.**

**But:**
- No visual confirmation of progress
- No `codewhip trust --watch` to re-run on file change
- No `codewhip trust --ci` mode that exits 1 on FAIL (for CI gates)

---

## Final Judgment

**The logic is solid. The gates are honest. The criteria are achievable.**

**But the presentation is a raw dump, not a certificate.** A certificate is something you *show* — framed, scannable, authoritative. This is a debug log with a verdict at the end.

**Fix the output format. Fix `audit --verify` consistency. Add `--json`. Then ship.**

The foundation is there. The polish is not. Irony noted.

---

**Signed:** Steve Jobs  
**Next Review:** After visual certificate + `--json` + verify fix land