import { getProviderConfig, isLoopbackBaseUrl } from "./custom-providers.js";
import { isModelAllowed, loadAllowedEntries, parseEntry } from "./model-allowlist.js";
import { listAgentsWithErrors, type AgentDef } from "./subagents.js";

/**
 * Consent for the model ids a roster can dial.
 *
 * A subagent's `model:` rides the PARENT's port (`src/tools/child-run.ts`
 * hands the child `ctx.port` and overrides only the id — see
 * `runChildAgent` in `src/subagents.ts`), so "was this model consented?" is
 * answered for every provider the run could hand a child: the routed head
 * plus each failover hop. That is the same rule the private class uses
 * (consent covers one target, so private runs lose their hops) and the same
 * one a pinned child uses for losing its rotation list.
 *
 * This is SURFACE on purpose. The allowlist file is a surface artefact and the
 * roster vocabulary is core; `src/boundary.test.ts` keeps core free of the
 * provider table, so the gate lives in the mouths that resolve the provider —
 * one function, two callers (CLI + SDK) — rather than a second mechanism
 * inside the child runner that could drift from the head gate.
 */

export type UnconsentedPin = { name: string; model: string };

/** Loopback runtimes are exempt on the same terms as the head gate: the
 * registration is the consent there (nothing leaves the machine). */
function consentedOn(provider: string, model: string, dir?: string): boolean {
  const cfg = getProviderConfig(provider);
  if (cfg !== null && isLoopbackBaseUrl(cfg.baseUrl)) return true;
  return isModelAllowed(provider, model, dir);
}

/**
 * Every roster entry this run could dial without consent. Resolved from disk
 * like the loop does (`loop.ts` re-derives the roster itself, which is why a
 * caller cannot strip a pin and why the answer is to refuse the run).
 */
export function unconsentedAgentModels(
  cwd: string,
  extra: readonly AgentDef[],
  providers: readonly string[],
  dir?: string,
): UnconsentedPin[] {
  const { agents } = listAgentsWithErrors(cwd, extra);
  const out: UnconsentedPin[] = [];
  for (const a of agents) {
    if (a.model === undefined) continue;
    const model = a.model;
    if (providers.length > 0 && providers.every((p) => consentedOn(p, model, dir))) continue;
    out.push({ name: a.name, model });
  }
  return out;
}

/** Providers holding this exact id — so the refusal can say what to do. */
export function providersAllowing(model: string, dir?: string): string[] {
  const out: string[] = [];
  for (const entry of loadAllowedEntries(dir)) {
    const k = parseEntry(entry);
    if (k !== null && k.model === model && !out.includes(k.provider)) out.push(k.provider);
  }
  return out;
}

/**
 * The one sentence every call surface shows for an unconsented id.
 *
 * The second form is the one that matters: the likeliest real-world stale pin
 * is an id the author enabled on *their* provider. Telling that person to run
 * `codewhip provider enable kilo:…` while the run routes nvidia sends them
 * down a hole, so the sentence names the provider the id actually belongs to.
 */
export function notEnabledMessage(provider: string, model: string, dir?: string): string {
  const elsewhere = providersAllowing(model, dir);
  if (elsewhere.length > 0) {
    return `model "${provider}:${model}" is not enabled on this route — that exact id is enabled for ${elsewhere.join(", ")}; an agent's model is a model on the RUN's provider, so drop the \`model:\` line or run with --provider ${elsewhere[0]}`;
  }
  return `model "${provider}:${model}" is not enabled — run: codewhip provider enable ${provider}:${model} (see: codewhip provider allowed)`;
}
