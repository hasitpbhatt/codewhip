# architecture — topic memory (NOT auto-injected)

Read alongside `MEMORY.md` when touching `serve.ts`, the port/adapter layer, retry
classification, pricing, or the task classifier.

## `codewhip serve` — `src/serve.ts`
`model` = `"<provider>:<model>"` split at the FIRST colon (model ids keep theirs);
bare provider id = its default; bare model id = the server default (keyless
`llm7`). The client always gets a real OpenAI SSE stream — the server synthesizes
deltas when the upstream doesn't stream. `startServe` THROWS on a non-loopback bind
without `--token`. Model proxy only: no tools, no policy, no audit entries. Serve
tests must capture the real `fetch` BEFORE stubbing it, or they intercept their own
requests.

**Shutdown.** `server.close()` is NOT idempotent — each call adds a 'close'
listener, so 11 calls trip `MaxListenersExceededWarning: 11 close listeners added
to [Server]`; and it waits on live connections, which an idle keep-alive socket
never ends, so the process hangs. The warning is usually a *symptom of the hang*,
because the operator keeps pressing Ctrl-C. Route shutdown through
`createShutdown()`: idempotent, `closeIdleConnections()`, unref'd force-exit timer,
second signal exits now.

**Cloudflare Workers** (assessed 2026-09-13): `http.createServer` IS now supported
(`enable_nodejs_http_server_modules` + `nodejs_compat`, auto on at compat date >=
2025-09-01) via `httpServerHandler` from `cloudflare:node`. But `listen()` takes no
host — the port is a *routing key*, not a socket — and `closeAllConnections()` /
`closeIdleConnections()` are NOT implemented; `'socket'`/`'upgrade'` are
unsupported; `node:fs` is an empty in-memory FS. So `serve` does not port as
written; the core does. For private reachability a `cloudflared` tunnel beats a
Workers port.

## A non-OpenAI-shaped provider: add a port, don't widen the row
`port: "<name>"` on the row + a `PortKind` member, branched once in
`makePortForConfig` — never special-case by id at call sites. The adapter may
import `wire-util.ts`/`provider-port.ts` but NOT `provider.ts` at runtime: the
registry imports the adapter, so that direction is a cycle. Keep it out of
`FREE_CHAIN` if credit-metered from call one. Test pure translation functions
against a stubbed `globalThis.fetch`; never live-test an adapter. 1min specifics:
`src/onemin.ts`.

## Cost is computed in TWO places
`costNote()` (`index.ts`, the receipt shown to the user) and `estimateCost()`
(`router.ts`, the polish-routing gate) price the same route independently. A
pricing change is half-done until both are touched — they silently disagreed once,
leaving the receipt telling the user to "check the provider console" for a local
runtime that cannot have a bill. A loopback runtime must print `$0.0000 (local
runtime)` from both paths.

## Regex: an outer `\b` cannot precede a literal `.`
`\b\.env\b` was dead in the common case — a word boundary never occurs immediately
before `.` — so `.env` prompts routed to a cloud free tier. Fixed with `|\.env\b`.
**Transferable:** the test that "covered" `.env` actually matched the `api key`
alternative — an assertion passing via a different branch proves nothing about the
branch it appears to cover. Test each alternative in isolation.
Same family: `\bkeyword\b` cannot match plurals, which left 18/31 secret-touching
prompts classified as `implement` (routed to a cloud free tier). Fixed with a
trailing `s?` plus a synonym group — recall 13/31 → 31/31, 0 false positives,
pinned by regression tests.

## Open defects from the audit
- `ppio` has `envVar: "PIO_API_KEY"` — missing a P; the only id-vs-envVar outlier,
  and a public contract (printed in `codewhip help`), so renaming is deliberate.
- Catalog-derived `defaultModel` slugs are never live-probed: the 18 added
  2026-09-13, plus `hcnsec` (`auto`), `hashneuron` (`default`) and the whole 1min
  adapter — no provider key exists on this machine, so none has made a real call.
- `src/provider-stats.ts` holds a deliberate `\x00` separator, making it invisible
  to ripgrep. Read it, don't grep it.
