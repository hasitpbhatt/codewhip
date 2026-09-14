# providers — topic memory (NOT auto-injected)

Read alongside `MEMORY.md` when adding or changing providers, auditing the free
chain, or touching `provider.ts` / `auth.ts` / `free-providers.ts` /
`custom-providers.ts`.

## The `--free` invariant, in practice
`--free` = "never bills pay-go". A provider whose free tier starts needing a
payment method must LEAVE `FREE_CHAIN` even while it still answers — it stays a
builtin reachable via `--provider`.

Rot found this way: `lepton` (removed — Lepton AI ceased operations 2025-05-20
after the NVIDIA acquisition), `chutes` (left the chain; host is `llm.chutes.ai`),
`cerebras` (left the chain and both `$0` lists — card-bound credits).

Out on the same principle — keyed gateways whose free grant is quota/prepaid
metered, so a call past it can spend money:
- `1min` — credit-metered from call one; also non-OpenAI-shaped (own port).
- `hcnsec` — New API relay; free allowance is an unpublished console quota.
  `defaultModel: "auto"` is its documented smart-routing id.
- `hashneuron` — RouteOpen gateway (`hashneuron.space`, standard Bearer auth and a
  standard error envelope, so no adapter). 500,000 tokens/day per account reset at
  UTC midnight, then it draws on a *prepaid balance* with a ledger.
  `defaultModel` is the literal id `default`: the console's own model picker
  renders it as "Auto" (`id === "default" ? "Auto" : id` in its app.js), i.e. the
  server-side routing entry — the one id guaranteed to survive a catalog change.
  Promote to `FREE_CHAIN` only if a re-audit confirms the daily grant is card-free
  AND 429s on exhaustion.

Free tiers expire: re-audit against `free-llm.com` and probe suspected-dead
endpoints (a transport-layer failure is the tell). Distinguish "dead" from
"declared maintenance": `empero` answers 503 with `code:"maintenance"` and "We are
switching the free endpoint to new models" — NOT dead. It doesn't bill, so it stays
in the chain; re-verify its `defaultModel` and `$0` price on return.

## Test invariants easy to trip (when adding a provider)
- Every row: `envVar.endsWith("_API_KEY")`, `baseUrl.startsWith("https://")`. A
  console calling its credential `*_API_TOKEN` (Cloudflare, Friendli, Coze) must
  still be named `*_API_KEY` here.
- A new **keyless** hop (one with an `anonymousKey`) shifts `freeChainCandidates()`,
  breaking the groq-neighbour assertions (`withKey[i±1]` === `pollinations`/`llm7`)
  and `keylessFirst[4] === "llm7"`. New keyed hops are safe.
- `FREE_CHAIN` keeps keyless `llm7` LAST — the keyless floor.

## Local runtimes + the `private` class (closed 2026-09-14)
`custom-providers.ts` accepts `http://` on **loopback only** (`isLoopbackBaseUrl`:
localhost, 127.0.0.0/8, ::1, [::1]) — elsewhere plain http would put the key on the
wire in clear text. `routeFor("private")` returns the registered loopback provider
when exactly one exists, else refuses (none, or several = ambiguous). A
secret-bearing prompt never reaches a remote model without an explicit
`--provider`. Gotchas:
- BOTH `normalize()` and `isValidRecord()` must accept loopback http, or a saved
  entry vanishes on reload.
- A loopback provider gets `anonymousKey: "local"` because `index.ts:597` and
  `serve.ts:342` refuse an empty key — else the route resolves then aborts.
- The id `ollama` is taken by the *remote* ollama-cloud builtin, so local
  registrations need `ollama-local`; the registration error suggests it.
Proved end-to-end by dogfooding `codewhip serve` itself as the loopback runtime
(no Ollama on this machine): `serve --port 11434 --provider llm7`.

## Account-scoped base URLs (Cloudflare)
The Cloudflare row carries `{CLOUDFLARE_ACCOUNT_ID}` (Workers AI scopes by
account), substituted from `process.env` ONLY at URL-build time —
`candidateBaseUrls()` and the logged `host` keep the template, so no account id
reaches disk. Helpers live in `src/wire-util.ts` (extracted to keep adapters off
the registry's cycle; `provider.ts` re-exports); both refuse with a pointed error
when unset.

## Providers ruled out 2026-09-13 — don't re-add without new evidence
Dead: `glhf.chat` (→ Synthetic, paid), `kluster.ai`, yi/01.AI, anyscale, octoai.
Alive but priced: `morph`.
Need a real adapter (not plain OpenAI-compat + Bearer): Nous Portal and GitHub
Copilot (both OAuth), Azure OpenAI (deployment-scoped path), Amazon Bedrock
(SigV4). Community g4f Discord proxies (zukijourney, ElectronHub, NagaAI, …) have
no SLA, unstable hosts and upstream-ToS problems — they contradict the trust
wedge. `github models`: directories disagree; probe first.

## Keyed gateways are aggregators, not vendors
`hcnsec` and `hashneuron` relay prompts to upstream models, so their operators see
every prompt in plaintext and per-model availability is not guaranteed. Never send
secrets through them; say so in the docs when adding one.

## .md is not truth
The registry is `src/provider.ts`; codewhip never reads .md. Never treat a count in
any .md as authoritative. `docs/paper/reviews/*` are dated transcripts (they still
say "51 builtins") — history, not documentation.
