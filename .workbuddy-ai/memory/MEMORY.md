# codewhip — project memory

## How to add a builtin LLM provider (non-obvious, verified 2026-09-11)
Adding a builtin is NOT one file. All of these must be touched or tsc/tests break:
1. `src/provider.ts`: add id to `BuiltinProviderId` union, `PROVIDER_IDS` array,
   and a `PROVIDERS` row. Port logic is generic OpenAI-compat (`openAiPort`); only
   `baseUrl`/`chatPath`/`envVar`/`keyUrl`/`anonymousKey`/`headers` matter.
2. `src/auth.ts`: `FIELD_BY_PROVIDER` is `Record<BuiltinProviderId,string>` —
   MISSING an entry fails `tsc`. Also add optional `StoredCreds` field.
3. `src/free-providers.ts`: if it's a free tier, add a `FREE_CHAIN` entry.
4. Tests assert counts/order: `provider.test.ts` (`PROVIDER_IDS.length === 16`
   → bump), `auth.test.ts` (same length), `free-providers.test.ts`
   (`CHAIN_ORDER` string, keyless join, `rows.length === 11` → bump,
   `keylessFirst[3]` index, groq-neighbor `withKey[i-1]`). Bump all on change.
Run `npx tsc --noEmit`, `npm run build`, `npx tsx --test src/provider.test.ts
src/auth.test.ts src/free-providers.test.ts`.

## Provider data lives in code, not markdown
codewhip never reads .md. Research lists go in `docs/` as reference only; the
real registry is `src/provider.ts`. Keyless tiers use `anonymousKey: "unused"`.
