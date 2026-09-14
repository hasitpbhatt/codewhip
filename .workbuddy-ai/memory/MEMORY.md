# codewhip — project memory (index)

The ONLY auto-injected memory file — keep it small. Topic files in this directory
are NOT auto-injected; open them when a task touches them:
- `providers.md` — adding/changing providers, free chain, per-provider rot,
  ruled-out candidates, local/loopback runtimes, account-scoped URLs.
- `architecture.md` — `serve`, port/adapters, retry classification, cost
  functions, regex pitfalls, Cloudflare, open defects.
Daily logs (`YYYY-MM-DD.md`) hold the full narrative.

## Verify like this (2026-09-14 — cost a false green)
`npm run <script> | tail -N` LIES TWICE: the pipe makes the exit code `tail`'s
(always 0), and npm's banner is block-buffered on a pipe while tsc's stderr is
unbuffered, so errors flush FIRST and `tail` shows only the banner. Run gates bare
(`npm run lint; echo $?`) or redirect to a file.

## Adding a builtin provider — NOT one file
1. `provider.ts`: id in `BuiltinProviderId` (ONE long union line) + `PROVIDER_IDS`
   + a `PROVIDERS` row. Only `baseUrl`, `chatPath`, `modelsPath`, `envVar`,
   `keyUrl`, `anonymousKey`, `headers` matter — the port is generic (`openAiPort`).
2. `auth.ts`: `FIELD_BY_PROVIDER` is `Record<BuiltinProviderId,string>`, so a
   missing key is a hard `tsc` error (TS2741) in a *different file*; add the
   `StoredCreds` field too. This is the step an interrupted edit drops.
3. `free-providers.ts`: only if genuinely free (see the `--free` invariant).
4. Bump the EXACT-equality counts: `PROVIDER_IDS.length` in `provider.test.ts` and
   `auth.test.ts` (**54**); `CHAIN_ORDER` + `listFreeProviders().rows.length` in
   `free-providers.test.ts` (**44**).
5. Never hardcode a count in prose — that is how `serve.ts` went stale.
6. After a batch of edits, READ THE FILE BACK: parallel edits to one file have
   silently dropped writes here. Duplicate keys ARE caught (tsc TS1117, oxlint
   `no-dupe-keys`) — just not by a piped tail.
7. Row invariants and the keyless-hop assertions that break on a new
   `anonymousKey` provider: see `providers.md`.

## Retry classes — `RetryableKind` (provider-port.ts)
`rate-limited` (429) | `timeout` | `server` (5xx, 408) | `auth` | `other`. The loop
rotates on the first THREE; `auth`/`other` are terminal. `server` added
2026-09-14: a 5xx used to be terminal, so `empero`'s maintenance 503 stranded a
`--free` run instead of letting it hop. Classified in TWO adapters (`provider.ts`
`httpFailure`, `onemin.ts`) — change both. `serve.ts`: server→502, timeout→504.

## The `--free` invariant (the core promise)
`--free` = "never bills pay-go". A provider whose free tier starts needing a
payment method must LEAVE `FREE_CHAIN` even while it still answers — it stays a
builtin reachable via `--provider`. Never leave a `$0` price in `router.ts`
`PRICE_PER_1K` or `index.ts` `costNote()` for a provider that bills.
