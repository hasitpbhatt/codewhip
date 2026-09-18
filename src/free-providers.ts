import { resolveKey } from "./auth.js";
import { FREE_CHAIN, type FreeProviderEntry } from "./free-chain.js";
import { PROVIDERS, type BuiltinProviderId } from "./provider-registry.js";

export { FREE_CHAIN, type FreeProviderEntry } from "./free-chain.js";

/** Chain entry joined with its builtin registry columns. */
export type FreeProviderRow = FreeProviderEntry & {
  brand: string;
  envVar: string;
  keyUrl: string;
};

/** Ordered chain ids (keyless tiers first; llm7 keyless floor last). */
export function freeChainIds(): BuiltinProviderId[] {
  return FREE_CHAIN.map((e) => e.id);
}

/** Chain entries joined with their PROVIDERS config rows. Pure, never throws. */
export function listFreeProviders(): FreeProviderRow[] {
  const rows: FreeProviderRow[] = [];
  for (const e of FREE_CHAIN) {
    const cfg = PROVIDERS[e.id];
    if (cfg === undefined) continue;
    rows.push({ ...e, brand: cfg.brand, envVar: cfg.envVar, keyUrl: cfg.keyUrl });
  }
  return rows;
}

/**
 * Chain ids the run can actually use: resolveKey must yield a non-empty
 * key (env, stored file, or the provider's anonymousKey). This is the
 * `--free` chain source — keyless rows always pass via anonymousKey.
 */
export function freeChainCandidates(): BuiltinProviderId[] {
  return freeChainIds().filter((id) => resolveKey(id).key.length > 0);
}
