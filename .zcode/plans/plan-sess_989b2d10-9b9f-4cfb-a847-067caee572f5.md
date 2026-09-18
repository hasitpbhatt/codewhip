# Fix playground "one model per provider": invalidate cache, rebuild, restart

## Root cause (confirmed, not guessed)

`dist/serve.js` is dated **Sep 16 02:35**; `src/serve.ts` was last changed **Sep 16 19:15**. The built file contains **zero** references to `listModels` / `catalogCache` / `clearModelCatalogCache` and 9 `defaultModel` references — i.e. the running built server serves the **old default-model-only listing**, which is exactly the "one model per provider" you see.

Proof the source is already correct: starting the server **from `src`** (via `tsx`) returns **742 rows across 76 providers** — nvidia 82, opencode 71, llm7 47, sensenova 4, stepfun 15. The code is right; the **artifact you're running is stale**.

Note: providers with no key legitimately fall back to a single `<provider>:<default>` row — that's by design. Only keyed/anonymous providers expand to full catalogs.

Secondary bug found: `package.json`'s `"serve": "node dist/serve.js"` can never work — `serve.ts` exports `startServe` but has no main-guard, so that script exits immediately without listening. Serve only actually runs via `node dist/index.js serve`.

## Part 1 — Cache invalidation (source changes)

1. **`src/serve.ts` — forced refresh on `/v1/models`**
   - `modelList(opts, force = false)`: when `force` is true, skip the `CATALOG_TTL_MS` check and rebuild the sweep (still write the fresh cache).
   - Route handler: `GET /v1/models?refresh=1` (or `?refresh=true`) passes `force = true`. Normal loads keep the 60s TTL.
2. **`src/serve.ts` — playground refresh affordance**
   - Add a "refresh" button beside the model badge that fetches `/v1/models?refresh=1` and re-renders.
   - `loadModels(force)` takes the flag; the initial load uses the cached path.
   - Refactor the retry button to share the same `loadModels` path (it currently duplicates the fetch).
3. **`src/serve.ts` — playground HTML cache**
   - `playgroundCache` is a module-level one-shot; HTML edits require a restart. Leave as-is but note it — the restart in Part 2 covers it.
4. **`package.json` — fix the broken serve script**
   - Change `"serve": "node dist/serve.js"` → `"serve": "node dist/index.js serve"` so `npm run serve` actually listens.

## Part 2 — Rebuild + restart (so you can validate on /playground)

1. `npm run build` — regenerate `dist/` from current `src/`.
2. Verify the artifact changed: `listModels`/`clearModelCatalogCache` now present in `dist/serve.js`.
3. Stop the running serve process on port 8787 (find the PID, then stop it gracefully).
4. Restart with `node dist/index.js serve` (or `npm run serve` after the script fix).
5. **Validate**:
   - `curl 'http://127.0.0.1:8787/v1/models'` → expect hundreds of rows, many providers with >1 model.
   - `curl 'http://127.0.0.1:8787/v1/models?refresh=1'` → bypasses TTL, returns fresh.
   - Open [http://127.0.0.1:8787/playground](http://127.0.0.1:8787/playground) and confirm optgroups list full per-provider catalogs; streaming now parses (the `split('\n')` fix).

## Tests
- `src/serve.test.ts`: add a case asserting `?refresh=1` rebuilds the catalog after a change (e.g. add a custom provider, confirm it appears without waiting for the TTL).
- Keep the existing live-catalog + `--ping-models` tests green.

## Verification
- `npm run lint`, `npm run typecheck`, `npm test` all clean (currently 425/425).
- Live curl checks above on the rebuilt server.

## Scope guard
No new deps, no persistence layer. Refresh is a query param + one button; the TTL stays the default.