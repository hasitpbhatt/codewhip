# codewhip — project memory

## How to add a builtin LLM provider (non-obvious; re-verified 2026-09-13)
Adding a builtin is NOT one file. All of these must be touched or tsc/tests break:
1. `src/provider.ts`: add id to `BuiltinProviderId` union, `PROVIDER_IDS` array,
   and a `PROVIDERS` row. Port logic is generic OpenAI-compat (`openAiPort`); only
   `baseUrl`/`chatPath`/`envVar`/`keyUrl`/`anonymousKey`/`headers` matter.
2. `src/auth.ts`: `FIELD_BY_PROVIDER` is `Record<BuiltinProviderId,string>` —
   MISSING an entry fails `tsc`. Also add the optional `StoredCreds` field.
3. `src/free-providers.ts`: if it's a free tier, add a `FREE_CHAIN` entry.
4. Bump the count assertions — they are exact equality, not ranges:
   `provider.test.ts` `PROVIDER_IDS.length` (51), `auth.test.ts` (51),
   `free-providers.test.ts` `CHAIN_ORDER` string + `listFreeProviders()
   rows.length` (44).
Run `npm run lint && npm run typecheck && npm run build && npm test`.

## The `--free` invariant (learned the hard way, 2026-09-13)
`--free` is documented as "never bills pay-go". So a provider whose free tier
starts requiring a payment method must LEAVE `FREE_CHAIN` even while it still
answers — it can stay a builtin, reachable via `--provider`. Corollary: never
leave a `$0` price in `router.ts` `PRICE_PER_1K` or in `index.ts` `costNote()`
for a provider that has started billing; that sticker is a fiction and this
project's whole trust story is "the meter never lies".
Rot found this way: `lepton` (dead → removed), `chutes` (pay-per-token → left
chain; its host is `llm.chutes.ai`, not `api.chutes.ai`), `cerebras` (card-bound
credits → left chain + dropped from both $0 lists).

## Free tiers have a shelf life — re-audit, don't assume
Three rows shipped in one session had already expired. When auditing, check
`free-llm.com` for explicit "discontinued"/"no longer free" flags, and verify a
suspected-dead endpoint by fetching it (a transport-layer failure is the tell).

### Invariants the test suite enforces (easy to trip)
- `provider.test.ts`: EVERY row must satisfy `envVar.endsWith("_API_KEY")` and
  `baseUrl.startsWith("https://")`. A provider whose console calls its
  credential an `*_API_TOKEN` (Cloudflare, Friendli, Coze) must still be named
  `*_API_KEY` here.
- `free-providers.test.ts` pins hop ORDER. Adding a provider that resolves a key
  with no env set (i.e. an `anonymousKey`) shifts `freeChainCandidates()` and
  breaks the groq-neighbour assertion (`withKey[i-1] === "pollinations"`,
  `withKey[i+1] === "llm7"`) and `keylessFirst[4] === "llm7"`. New keyed hops
  are safe; new keyless hops are not.
- `FREE_CHAIN` must keep the keyless `llm7` LAST (it is the keyless floor).

## Account-scoped base URLs (Cloudflare, added 2026-09-13)
Cloudflare Workers AI serves OpenAI-compat under `/accounts/<id>/ai`, so the row
carries `{CLOUDFLARE_ACCOUNT_ID}`. `resolveBaseUrl()` / `unresolvedBaseUrlVars()`
in `src/provider.ts` substitute from `process.env` ONLY at URL-build time —
`candidateBaseUrls()` and the `host` in provider-stats.jsonl keep the template,
so no account id reaches disk or the log. `openAiPort` and `listModels` both
refuse the call with a pointed error when the var is unset (otherwise the empty
path segment reads as "unknown model"). `custom-providers.ts` has no equivalent
— its `normalize()` only accepts plain `https://` origins, and rejects `http://`,
so local runtimes (Ollama/vLLM) still cannot be registered.

## Open gap: the router's `private` class has no local provider
`routeFor("private")` in `src/router.ts` returns an error — "private class needs
a local provider (not wired)". So the README's `private → local` route has
nothing behind it, and the two fixes are coupled: a local row (`http://localhost`
Ollama/vLLM) AND relaxing `custom-providers.ts` to accept loopback `http://`.
Not done as of 2026-09-13; it changes the `private`-class contract, so it needs
a decision first.

## Provider data lives in code, not markdown
codewhip never reads .md. The registry is `src/provider.ts` — full stop. A
candidate/research list was written on 2026-09-13 and deleted the same day once
its contents were implemented or encoded in code comments + tests. Don't
recreate one, and never treat a provider count in any .md as authoritative.
Keyless tiers use `anonymousKey`.

## Providers ruled out (surveyed 2026-09-13) — don't re-add without new evidence
Free-API directories keep resurfacing these:
- Dead: `glhf.chat` (→ Synthetic, paid), `kluster.ai`, yi/01.AI, anyscale
  endpoints, octoai. Alive but priced: `morph`.
- Real but NOT plain OpenAI-compat + Bearer (need an adapter): Nous Portal
  (OAuth), GitHub Copilot (OAuth), Azure OpenAI (deployment-scoped path),
  Amazon Bedrock (SigV4).
- Community g4f Discord proxies (zukijourney, ElectronHub, NagaAI, …): no SLA,
  unstable hosts, upstream-ToS problems — contradicts the trust wedge.
- `github models`: directories disagree (active vs "discontinued"); probe first.
