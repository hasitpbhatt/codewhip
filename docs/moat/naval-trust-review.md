# Naval Ravikant Review: `codewhip trust` Command

## Verdict: NEEDS WORK

The command exists. It prints a certificate. But it fails the three tests that matter:

---

### 1. Does it create compounding value?

**No.** The trust certificate is a snapshot, not a lever.

- **Polish gate is hardcoded to "not evaluated this run"** (line 1214). It never actually checks whether a polish task ran and passed the <$0.05 gate. The router has `polishGate()` that returns `{pass, reason}` — the trust command ignores it entirely. A team lead at 2am gets "not evaluated" when they need to know: *did the last polish run prove cheap?*

- **Memory check is a tautology**: `remembered.length >= 0` (line 1248) is always true. "0 rules accruing" and "50 rules accruing" both pass. The gate should require *some* memory or at least distinguish "no memory yet" from "memory compounding."

- **Keys check treats anonymous/keyless as "ready"**. Providers like `llm7`, `opencode`, `kilo`, `empero`, `pollinations` have `anonymousKey` set — they show as "ready (anonymous)" but are rate-limited to the point of uselessness for real work. The certificate lies: it says "keys ready" when the keys don't actually unblock work.

- **Policy.md "active" means "has any deny line"**. A policy.md with one `deny bash:rm -rf /` counts as "active." That's not a policy — that's a placeholder. The gate should require *promoted* denies (human-refined, battle-tested) or at least a non-trivial count.

**Compounding value** means each run makes the next run cheaper/faster/safer. This command reads state but doesn't enforce the loop that builds it.

---

### 2. Is it simple?

**No.** It's a 60-line function doing 7 different checks with inconsistent output formats.

- Audit chain: prints `INTACT/BROKEN` with full breakdown — good
- Policy: prints "X promoted deny(es) active" or "no promoted denies" — inconsistent tense
- Polish gate: hardcoded string, not a real check — broken
- Memory: "N remembered rule(s) accruing" — vague verb
- Keys: "N ready, M missing" then lists missing — but "ready" includes anonymous keyless providers
- Policy.md: "active (has denies)" or "empty or missing" — binary, no nuance
- Summary: "TRUST: PASS | NEEDS WORK" with generic follow-up commands

The output format doesn't match the spec in the prompt:
- Spec: "audit chain: INTACT/BROKEN (seq, sigs, key)" → Actual: prints all details inline
- Spec: "policy: promoted denies active count" → Actual: prints full sentence
- Spec: "polish gate: not evaluated / PASS / OPEN (needs priced run)" → Actual: hardcoded "not evaluated this run"
- Spec: "memory: N remembered rules accruing" → Matches but always passes
- Spec: "keys: N ready (source), M missing (list)" → Actual: "N ready, M missing" then lists missing separately
- Spec: "policy.md: active/empty-or-missing" → Matches
- Spec: "TRUST: PASS | NEEDS WORK (with actionable next commands)" → Generic commands, not contextual

**Simple** means: one mental model, one output format, zero surprises. This has seven.

---

### 3. Does it respect the user's time and attention?

**No.**

- The polish gate lie wastes the 2am team lead's time — they'll run a polish task, then run trust again, get the same "not evaluated," and lose trust in the tool.
- The keys section lists 30+ providers as "ready (anonymous)" — noise. The user cares: *which providers can I actually use for real work?* Not "which providers have a dummy key?"
- The follow-up commands are generic: `codewhip audit --verify`, `codewhip auth status`, `codewhip policy list`, `codewhip remember list`. They don't say *what specifically failed*. If policy.md is missing, say `codewhip init`. If keys are missing for nvidia, say `codewhip auth login nvidia`. If no promoted denies, say `codewhip policy candidates`.

---

## Specific Fixes (Priority Order)

### P0 — Fix the polish gate
```typescript
// In cmdTrust(), read the last polish-class run from outcomes.jsonl
// and compute its actual polishGate(cost) result.
// If no polish run exists: "polish gate: not evaluated (run a polish task)"
// If cost is null: "polish gate: OPEN — needs priced route (not free-tier)"
// If cost >= 0.05: "polish gate: OPEN — $X.XXXX >= $0.05"
// If cost < 0.05: "polish gate: PASS — $X.XXXX < $0.05"
```

### P0 — Fix the memory gate
```typescript
// Require >= 1 remembered rule for PASS, or at minimum:
// "memory: 0 rules (run codewhip remember to start compounding)"
// vs "memory: 12 rules accruing"
```

### P0 — Fix keys: separate "usable" from "anonymous"
```typescript
// Usable = env or file source (real keys)
// Anonymous = anonymousKey fallback (rate-limited, not for production)
// Missing = no key at all
// Output: "keys: 3 usable (nvidia:env, groq:file, gemini:env), 2 anonymous (llm7, opencode), 27 missing"
```

### P1 — Make follow-up commands contextual
```typescript
// Build the "next commands" list from actual failures:
const next: string[] = [];
if (!v.valid) next.push("codewhip audit --verify");
if (keysMissing.length > 0) next.push(`codewhip auth login ${keysMissing[0]}`);
if (!policyActive) next.push("codewhip init  # scaffolds policy.md + key");
if (remembered.length === 0) next.push("codewhip remember  # start compounding memory");
// Print only the relevant ones
```

### P1 — Match the spec output format exactly
The spec defines a contract. The implementation should honor it line-for-line so scripts can parse it.

---

## What's Good (Don't Lose)

- Audit chain verification is real, thorough, and correctly reports BROKEN on key deletion
- Promoted denies are the right primitive — they compound from human judgment
- The command exists as a single entry point — that instinct is correct
- No external dependencies, fast, no network calls

---

## The Naval Test

> "Does this create compounding value? Is it simple? Does it respect the user's time and attention?"

**Current score: 1/3.** The skeleton is there. The polish gate fix alone would move it to 2/3. Contextual next commands would make it 3/3.

**Ship the fixes. Then the command earns its name.**