# Provider Registry Curation Policy

CodeWhip's registry contains ~135 builtin providers. This document
explains the curation policy, verification standards, and removal
criteria.

## Adding a provider

A provider is added by appending one row to `PROVIDERS` and one entry
to `PROVIDER_IDS` in `src/provider-registry.ts`, plus the `envVar`
field to `StoredCreds` and `FIELD_BY_PROVIDER` in `src/auth.ts`.

### Required fields and standards

Every row must have:

- `id`: lowercase, `[a-z0-9-]` only
- `baseUrl`: must start with `https://` (loopback is the only exception
  for custom providers)
- `chatPath` and `modelsPath`: must start with `/`
- `envVar`: must end with `_API_KEY`
- `keyUrl`: a real URL where a user can get an API key
- `defaultModel`: must be a real slug, not fiction
- `timeoutMs`: must match the category (default 120000, or 8000 for
  community gateways)

### Verification standard

Default models are best-known slugs, NOT live-probed unless noted.
Every comment must be honest about verification status:

- **Verified**: live-probed with real data (tokens, latency, model list)
- **Unverified**: model slug assumed from docs, not tested
- **Ruled out**: tested and failed — documented in `docs/moat/` with
  the reason

### Honest rate limit hints

The `rateLimitedHint` must describe the actual constraint, not a
marketing promise:

- "free tier ~40 req/min — wait and retry" ✓
- "free tier available" ✗ (uninformative, not honest)
- "no forever-free tier: $5 credits need a verified card and expire
  in 30 days, then pay-go billing" ✓

## Removing a provider

### Automatic removal triggers

1. **410 Gone**: the model is permanently blocked from the provider
   for life (see `src/provider-blocklist.ts`). No recovery unless
   manually unblocked by a maintainer.
2. **Provider ceases operations**: the API domain no longer resolves
   or returns consistent errors. Remove from `PROVIDER_IDS` and
   `PROVIDERS`, add to the "ruled out" list in `docs/moat/`.
3. **Trial credit converted to paid**: if a provider's "free" tier
   starts requiring a payment method, it leaves `FREE_CHAIN` (but
   stays as a builtin reachable via `--provider`).

### Removal process

1. Add a note to `docs/moat/` with the date and reason
2. Remove from `PROVIDER_IDS` and `PROVIDERS` in `provider-registry.ts`
3. Remove from `FREE_CHAIN` if present (in `free-chain.ts`)
4. Remove `envVar` field from `StoredCreds` and `FIELD_BY_PROVIDER`
   in `auth.ts`
5. Update provider count in `provider.test.ts` and `auth.test.ts`
6. Check if it's in `PRICE_PER_1K` in `router.ts` and remove
7. Commit with "remove: <provider>" prefix

### Rot repair tracking

Every rot repair is documented in `docs/moat/` with:
- Date the provider left
- Why it left
- Whether it could return (and under what conditions)

Historical examples:
- `lepton` — Lepton AI ceased operations 2025-05-20, removed from
  registry entirely
- `cerebras` — dropped free tier, left FREE_CHAIN but stays builtin
- `chutes` — pay-per-token since 2026-03, left FREE_CHAIN

## Provider categories

### Free aggregators

Providers in `FREE_CHAIN`. They join the `--free` chain when their
key is present. Must never require a payment method for their free
tier.

### Keyed gateways (NOT free chain)

Providers that are free but require a key, or have prepaid balance
systems. Reachable via `--provider` but never in `--free`:
- `1min` — credit-metered from call one
- `hcnsec` — New API relay with unpublished console quota
- `hashneuron` — RouteOpen with prepaid balance ledger
- `tokenrouter` — OpenAI-compatible gateway, 14-day free trial

### Trial credit providers

One-time signup grants. NOT free, stays builtin only:
- `xai`, `novita`, `qianfan`, `deepseek`, `ppio`, `scaleway`,
  `friendli`, `nscale`, `nebius`, `ai21`, `together`, `deepinfra`,
  `fireworks`, `cometapi`, `mkeai`, `apiyi`

### Community relays

Volatile, no SLA, fast timeouts (8000ms). Never send private code:
- `zukijourney`, `nagaai`, `zanityai`, `kimetsu`, `navyapi`, `mnn`,
  `hcap`, `voltai`, `electronhub`, `xkiro`, `gonkarouter`,
  `bazaarlink`, `seldon`, `cavoti`, `getunikey`, `bynara`, `atria`,
  `onerouter`, `xpiki`, `suyu`, `voapi`, `nio`

## What the registry is NOT

The registry does NOT:
- Endorse any provider
- Guarantee uptime or availability
- Filter providers by quality, privacy policy, or ToS
- Gate what you may call (the registry is a directory; the separate
  model allowlist (below) is the consent layer that does)
- Collect any usage data about which providers users choose

The registry is a directory. It is honest about what it doesn't
filter.

## Gates: consent, capability, eligibility

Three independent gates stand between a request and an upstream call,
and all three must pass. They are deliberately separate so each can
change without touching the others:

1. **Consent — the model allowlist** (`src/model-allowlist.ts`,
   `allowed-models.json`). Deny by default: the file is a sorted set
   of *exact* `provider:model` ids and an absent or corrupt file means
   nothing is enabled. There are no wildcards — "enable all of a
   provider" writes the current live ids, so a catalog change can
   never silently re-open access. Enforced at the call sites (serve
   chat + auto-pick + /v1/models listing; CLI run pre-flight,
   `--models` rotation, `--free` chain, `--failover`, and the
   `routeFor`/`pickRandomHealthy` auto routes). Loopback locals are
   exempt in v1: registering one is the consent.
2. **Capability — the blocklist** (`src/provider-blocklist.ts`).
   An upstream HTTP 410 marks a model permanently dead; it is refused
   even when enabled. Maintainer-unblock only.
3. **Eligibility — health & billing** (`router.ts`). Auto paths never
   spend a paid key (`isAutoEligible`) and skip recently-failed
   combos (TTL deactivation, explore/exploit). A user key on an
   untracked route stays out of auto without
   `CODEWHIP_AUTO_INCLUDE_UNTRACKED=1`.

The older provider-level disable (`disabled-providers.json`) is
dormant — hidden from listings, not enforced; the per-model allowlist
replaced it.

## Security considerations for maintainers

- Community relays with "upstream-ToS problems" must be flagged
- Keyed gateways relay prompts in plaintext — must be disclosed in
  comments when adding
- No provider should be added without an honest `rateLimitedHint`
- `defaultModel` must never be fiction — if untested, say so

## AnonymousKey providers (keyless tier)

Providers with an `anonymousKey` in `PROVIDERS` (e.g. `kilo`, `opencode`, `llm7`)
run without a real API key. They are the keyless safety net: users with zero
configuration still get responses.

**CRITICAL RULE — the auth-header guard:**

When `resolveKey()` returns `{ source: "anonymous" }` for a provider, the
`openAiPort` function in `src/provider.ts` MUST NOT emit an
`Authorization: Bearer <anonymousKey>` header. The reason:

- **kilo**: free `:free` models work with *no* Authorization header at all.
  Sending `Bearer anonymous` triggers a 400 that would never occur with
  a real key (verified 2026-09-11).
- **opencode**: needs `x-opencode-session` identity headers (merged via
  `cfg.headers`), NOT a Bearer token. The `Bearer public` string causes
  rejection.
- **llm7**: anonymous "unused" key rejected by the API.

**This guard lives in `src/provider.ts:openAiPort`** — the `keySource`
parameter must be passed from `serve.ts` → `makePortForConfig` →
`openAiPort`, and the `Authorization` header must be conditionally
included only when `keySource !== "anonymous"`.

Adding a new `anonymousKey` provider? You MUST verify the actual
API authentication behavior and document it in the `PROVIDERS` row
comment.

## Audit trail

Every provider addition and removal is recorded in git history
with the date and reason. `git log --oneline --
author=<maintainer>` serves as the curation audit trail.
For formal governance records, see `docs/moat/00-convergence.md`.
