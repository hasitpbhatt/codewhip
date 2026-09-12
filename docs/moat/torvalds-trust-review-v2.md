# Linus Torvalds Review: `codewhip trust` Command (v2)

**Date**: 2026-09-12  
**Reviewer**: Linus Torvalds  
**Target**: `src/index.ts` — `cmdTrust()` function (lines 1194–1322)

---

## Executive Summary

The `trust` command is **conceptually solid** but has **one actual bug** (YAML deny parsing) and **several leaky abstractions** that will bite users. The PASS criteria are achievable but fragile. Code is readable but the policy parsing is wrong. Ship with fixes.

---

## 1. The Bug: YAML Deny Parsing Is Broken (Line 1229–1238)

```typescript
const inDenySection = false;  // NEVER USED
for (const line of raw.split("\n")) {
  const t = line.trim();
  if (t === "deny:") {
    continue;  // Does NOT set inDenySection = true
  }
  if (t.startsWith("- ") && t.includes('"')) {
    baseDenies++;
  }
}
```

**Problem**: `inDenySection` is declared but never set to `true`. The code counts **every** line in the file starting with `- "` — including comments, other list sections, or malformed YAML.

**Example of false positive**:
```yaml
defaults:
  read: allow
  edit: ask
# Some comment with - "fake deny" in it
other_section:
  - "this gets counted as a deny"
```

**Fix** (minimal, correct):
```typescript
let inDenySection = false;
for (const line of raw.split("\n")) {
  const t = line.trim();
  if (t === "deny:") {
    inDenySection = true;
    continue;
  }
  if (inDenySection && t.startsWith("- ") && t.includes('"')) {
    baseDenies++;
  }
  // Exit deny section on next top-level key
  if (inDenySection && t.length > 0 && !t.startsWith("- ") && !t.startsWith("#")) {
    inDenySection = false;
  }
}
```

**Verdict**: This is a **real bug**. Not theoretical. Fix before merge.

---

## 2. Polish Gate Detection Is a Heuristic, Not a Contract (Lines 1250–1252)

```typescript
const polishRuns = outcomes.filter((r) => {
  return r.model.includes("sensenova") || r.model.includes("flash") || r.model.includes("haiku");
});
```

**Problem**: The outcome record stores `model: "provider:model"` but **does not store `taskClass`**. So we guess polish runs by model name. This is:
- **Brittle**: User runs `--class polish` with nvidia → not detected
- **Wrong**: User runs implement with sensenova (explicit `--provider`) → false positive
- **Not extensible**: New polish-target providers break detection

**Root cause**: `OutcomeRecord` (outcomes.ts) lacks `taskClass` field. The router knows it at route time but doesn't persist it.

**Fix options**:
1. Add `taskClass?: TaskClass` to `OutcomeRecord` — append at run end (best)
2. Store route resolution in the run metadata
3. Accept the heuristic and document it loudly

**My take**: Add the field. One line in the type, one line at append. The schema is frozen per governance but this is a *new optional field* — old readers ignore it. Don't make me guess.

---

## 3. Missing Keys Are Collected But Never Shown (Lines 1284–1290, 1293–1299)

```typescript
// missingKeys collected here...
if (cfg.anonymousKey === undefined) {
  missingKeys.push(cfg.id);
}

// ...but never printed
lines.push(`  keys: ${usableKeys.length} usable (env/file), ${anonymousKeys.length} anonymous (rate-limited)`);
if (usableKeys.length > 0) lines.push(`    usable: ${usableKeys.join(", ")}`);
if (anonymousKeys.length > 0) lines.push(`    anonymous: ${anonymousKeys.join(", ")}`);
// missingKeys? Nowhere.
```

**Problem**: A user with zero keys sees:
```
keys: 0 usable (env/file), 4 anonymous (rate-limited)
```
But they have **38 providers configured**, 34 of which are "missing" — they just don't know it. The output lies by omission.

**Fix**: Show missing count at minimum. Better: list them.
```typescript
lines.push(`  keys: ${usableKeys.length} usable, ${anonymousKeys.length} anonymous, ${missingKeys.length} missing`);
if (missingKeys.length > 0) lines.push(`    missing: ${missingKeys.join(", ")}`);
```

---

## 4. PASS Criteria: Polish Gate Is Optional (By Design?) (Line 1306)

```typescript
const allGood = chainClean && baseDenies > 0 && hasMemory && usableKeys.length > 0;
// polishGatePassed is NOT in the criteria
```

**Observation**: The polish gate failure adds to `issues` and suggests a next step, but doesn't fail TRUST. This is **correct** — polish is a "prove you can do cheap work" gate, not a safety gate. But the asymmetry is confusing: `baseDenies > 0` is required (safety), `polishGatePassed` is not (economy).

**Recommendation**: Document the rationale in the output or comments. Currently it's implicit.

---

## 5. Memory Check Is Trivial (Line 1271)

```typescript
const hasMemory = remembered.length > 0;
```

**Problem**: One remembered rule = PASS. Could be `bash:echo *` from a demo. Doesn't validate that rules are:
- Valid shapes (curator validates on load — good)
- Actually used (no staleness check)
- Diverse across tools

**Mitigation**: The curator (`remember-store.ts:listRules`) already re-validates every line against `isValidStoredShape`. So hand-edited garbage gets filtered. But "at least one rule" is a very low bar.

**My take**: Acceptable for v1. The bar raises naturally as users accumulate real rules. Don't over-engineer.

---

## 6. Chain Verification Logic: Correct But Subtle (Lines 1200–1214)

```typescript
const preKeyProblems = v.problems.filter((p) =>
  p.includes("entry unsigned while a key exists")
);
if (preKeyProblems.length === v.problems.length && v.keyPresent) {
  chainStatus = "INTACT (pre-key entries unsigned as expected)";
  chainClean = true;
}
```

**Analysis**: This correctly handles the case where `codewhip demo --deny` runs *before* `codewhip init` generates the ed25519 key. Those early entries are unsigned — expected, not broken.

**Edge case**: What if user deletes the key, then runs more entries, then restores key? The new entries would be signed, old ones unsigned, middle ones... problematic. But `verifyChain` already catches "key deleted: private key present without pubkey — chain BROKEN" (audit.ts:236). So this is handled upstream.

**Verdict**: Correct. The logic is narrow and explicit. Good.

---

## 7. Policy File Display Is Good (Lines 1301–1303)

```typescript
lines.push(`  codewhip-policy.yaml: ${baseDenies > 0 ? "active (has base denies)" : "empty or missing"}`);
lines.push(`  policy.md: ${hasPromotedDenies ? `${promotedDenies.length} promoted deny(es)` : "no promoted denies"}`);
```

**Verdict**: Clear, shows both files, distinguishes base vs promoted. No complaints.

---

## 8. Next Steps Are Actionable (Lines 1309–1318)

```typescript
if (!chainClean) suggestions.push("codewhip audit --verify");
if (baseDenies === 0) suggestions.push("codewhip init (creates base policy with 3 denies)");
if (!hasMemory) suggestions.push("codewhip run ... (answer 'a' to remember a tool shape)");
if (usableKeys.length === 0) suggestions.push("codewhip auth login <provider> (or set env var)");
if (polishRuns.length > 0 && !polishGatePassed) suggestions.push("codewhip run --class polish \"...\" (prove <$0.05)");
```

**Verdict**: Excellent. Each failure maps to exactly one command. No guessing.

---

## 9. Technical Debt Inventory

| Location | Debt | Severity |
|----------|------|----------|
| `index.ts:1229-1238` | YAML deny parsing broken | **Critical** (bug) |
| `outcomes.ts:37-53` | `OutcomeRecord` missing `taskClass` | **Medium** (causes heuristic) |
| `index.ts:1284-1299` | Missing keys hidden from user | **Medium** (usability) |
| `index.ts:1250-1252` | Polish detection by model name heuristic | **Medium** (fragile) |
| `router.ts:111-118` | `polishGate` only works for priced routes | **Low** (by design, documented) |

---

## 10. Abstraction Leaks

1. **`resolveKey` → `cmdTrust` coupling**: Trust command reimplements key classification logic that `resolveKey` already does. Should use a shared helper or extend `resolveKey` to return richer info.

2. **`free-providers.ts` vs `provider.ts` duplication**: `FREE_CHAIN` duplicates provider IDs. If a builtin is added to `PROVIDERS` but not `FREE_CHAIN`, it won't appear in `--free`. Single source of truth needed.

3. **Policy parsing in two places**: `policy-store.ts:loadPromotedDenies` parses `policy.md`; `cmdTrust` parses `codewhip-policy.yaml`. Different formats, different parsers. Inevitable but fragile.

---

## Final Verdict

| Criterion | Pass? | Notes |
|-----------|-------|-------|
| **Code correct?** | ❌ | YAML deny parsing bug |
| **Simple?** | ✅ | ~130 lines, readable, minimal deps |
| **Doesn't break userspace?** | ✅ | Read-only, no side effects |
| **Abstractions leaky?** | ⚠️ | Three leaks noted above |
| **Technical debt?** | ⚠️ | Two medium items need fixing |

---

## Required Fixes Before Merge

1. **Fix YAML deny parsing** (index.ts:1229-1238) — critical bug
2. **Display missing keys** (index.ts:1293-1299) — usability
3. **Add `taskClass` to `OutcomeRecord`** (outcomes.ts + index.ts append) — kills the polish heuristic

## Acceptable As-Is

- Polish gate optional in PASS criteria (by design)
- Trivial memory check (v1 bar)
- Chain pre-key logic (correct)

---

**Signed**: Linus Torvalds  
**Action**: Fix the three items above, run `npm run lint && npm run typecheck && npm run build`, then merge.