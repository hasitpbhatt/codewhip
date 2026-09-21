import { PROVIDERS, type ProviderId } from "./provider.js";
import { getProviderConfig, isLoopbackBaseUrl, listAllProviderConfigs, listLocalProviders } from "./custom-providers.js";
import { resolveKey } from "./auth.js";
import { readProviderCalls, summarizeCalls, type ModelHealth } from "./provider-stats.js";
import { isBlocked } from "./provider-blocklist.js";
import { isModelAllowed } from "./model-allowlist.js";
import type { OutcomeRecord } from "./outcomes.js";

export type TaskClass = "implement" | "polish" | "private";

export type Route = {
  provider: ProviderId;
  model: string;
  /** Why this route (shown on the receipt line, not sent to the model). */
  note: string;
};

/**
 * Two dead-branch bugs have been fixed here, both of which silently routed
 * secret-touching prompts to a cloud free tier as `implement`:
 *
 * 1. `.env` sat OUTSIDE the leading `\b` group. A `\b` cannot match immediately
 *    before a literal ".", so `\b\.env\b` only ever fired when the dot was glued
 *    to a preceding word char ("foo.env") and missed every ordinary phrasing —
 *    "read the .env file", ".env is missing". Standalone `\.env\b` allows any
 *    preceding character.
 * 2. Every keyword was pinned to its SINGULAR form. `\bcredential\b` cannot
 *    match "credentials", `\bsecret\b` cannot match "secrets", `\bapi[-_ ]?key\b`
 *    cannot match "api keys" — so the plural, which is how people actually
 *    write, fell through. Hence the trailing `s?`.
 *
 * Measured 2026-09-14 against a 31-prompt corpus of secret-touching phrasings:
 * 13/31 caught before, 31/31 after. Both bugs were invisible to the old tests
 * because each one had an assertion that passed via a *different* alternative.
 *
 * Erring toward `private` is deliberate: a false negative leaks a secret to a
 * cloud model, while a false positive only refuses a run and says to pass
 * `--provider`. Regression-tested in router.test.ts.
 */
const PRIVATE_RX = /\b(password|passwd|passphrase|secret|credential|private key|api[-_ ]?key|access key|signing key|encryption key|master key|ssn|credit card|salary|internal only)s?\b|\b(bearer|auth|access|refresh|session)[-_ ]?tokens?\b|\bprod(uction)?\b.*\b(db|database|password)\b|\b(kubeconfig|connection string|recovery phrase|session cookie|service account)\b|\.env\b/i;
const POLISH_RX = /\b(typo|spelling|format(ting)?|lint|comment(s)?|rename|docs?|readme|polish|grammar|punctuation|whitespace|indent(ation)?)\b/i;

/**
 * ~5-line classifier: private signals win (safety first), then polish
 * signals, else implement. Heuristic, printed with its reason — the user
 * overrides with --class/--provider/--model, which always win.
 */
export function classify(prompt: string): { taskClass: TaskClass; reason: string } {
  if (PRIVATE_RX.test(prompt)) {
    return { taskClass: "private", reason: "private-signal keywords (secret/key/credential/.env…)" };
  }
  if (POLISH_RX.test(prompt)) {
    return { taskClass: "polish", reason: "polish-signal keywords (typo/format/lint/docs…)" };
  }
  return { taskClass: "implement", reason: "default (no polish/private signals)" };
}

/**
 * Class → provider:model. Implement rides the free capable tier; polish rides
 * the cheapest inference; private NEVER falls back to the cloud — it routes to
 * a local runtime the user registered, or it refuses.
 *
 * The refusal is the feature: the only way a secret-bearing prompt reaches a
 * remote model is an explicit `--provider`, which is informed consent and is
 * logged on the receipt line.
 */
/**
 * After this much silence a model's record is stale: the auto gate treats it
 * as unproven again instead of condemned. Without the reset an excluded model
 * never earns the new calls that would rehabilitate it — a bad hour would
 * lock it out of auto forever (the explore/exploit ratchet).
 */
export const STALE_HEALTH_MS = 24 * 60 * 60 * 1000;

/**
 * Share of CLI random-mode auto picks spent on candidates the health gate
 * excluded but that remain eligible and past their failure TTL — the epsilon
 * in explore/exploit, so a failed route is re-discovered instead of never
 * tried again. serve explores structurally: its health weights keep gated
 * models in the pool at reduced probability instead of hard-excluding.
 */
export const EXPLORE_RATE = 0.1;

/**
 * Recency-aware success rate for auto gating: the rolling RECENT_WINDOW once
 * it holds >= 5 calls, else the lifetime rate. Recency dominates so recovery
 * is immediate; the lifetime floor keeps thin history honest.
 */
export function healthRate(mh: ModelHealth): number {
  return mh.recentTotal >= 5 ? mh.recentSuccessRate : mh.successRate;
}

/**
 * The auto-pick health gate (CLI random mode + serve `model: "auto"` — one
 * rule, so the two cannot drift). No record or thin history passes (no data
 * is not failure); stale records pass (unproven again, STALE_HEALTH_MS);
 * otherwise the recency-aware rate must clear `floor`.
 */
export function healthPasses(mh: ModelHealth | undefined, floor: number): boolean {
  if (mh === undefined) return true;
  if (mh.total < 5) return true;
  if (mh.lastCallTs !== undefined && Date.now() - new Date(mh.lastCallTs).getTime() > STALE_HEALTH_MS) return true;
  return healthRate(mh) >= floor;
}

/**
 * Explore/exploit pool selection for uniform random auto picks. Spends
 * ~EXPLORE_RATE of picks (and all of them when nothing currently passes) on
 * gated-out-but-eligible candidates; injected `rng` keeps it testable.
 */
export function pickExplorePool<T>(pass: T[], gatedOut: T[], rng: () => number): { pool: T[]; exploring: boolean } {
  const wantExplore = gatedOut.length > 0 && (pass.length === 0 || rng() < EXPLORE_RATE);
  return wantExplore ? { pool: gatedOut, exploring: true } : { pool: pass, exploring: false };
}

function healthOk(providerId: ProviderId, model: string) {
  if (isBlocked(providerId, model)) return false;
  const records = readProviderCalls();
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return true; // no data yet
  const mh = ph.models.find((m) => m.model === model);
  return healthPasses(mh, 0.7);
}

export const TTL_MS = {
  quota: 15 * 60 * 1000,
  balance_low: 24 * 60 * 60 * 1000,
  auth: 60 * 60 * 1000,
  timeout: 5 * 60 * 1000,
  network: 5 * 60 * 1000,
  bad_model: 24 * 60 * 60 * 1000,
  other: 5 * 60 * 1000,
};

/**
 * Exported for `serve` auto-pick: the serve proxy reuses the same TTL
 * deactivation so `model: "auto"` never routes at a model the CLI just
 * watched fail. Single source for the TTL table lives here.
 * Also returns true when the model is permanently blocked (410 received).
 */
export function isRecentlyFailed(providerId: string, model: string): boolean {
  if (isBlocked(providerId, model)) return true;
  const records = readProviderCalls();
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return false;
  const mh = ph.models.find((m) => m.model === model);
  if (!mh || !mh.lastFailureTs || !mh.lastFailureOutcome) return false;
  const last = new Date(mh.lastFailureTs).getTime();
  const ttl = TTL_MS[mh.lastFailureOutcome as keyof typeof TTL_MS] ?? 5 * 60 * 1000;
  return Date.now() - last < ttl;
}

/**
 * Paid-key protection shared by every auto path (CLI `CODEWHIP_AUTO_RANDOM=1`
 * and serve `model: "auto"` / `--provider auto`). Auto only spends keys that
 * are free by construction:
 * - `anonymous` source — keyless free tiers (llm7, kilo, opencode, …), or
 * - a route with a known $0 price — a user key there only raises rate limits.
 *
 * A user-supplied key (`env`/`file`) on an untracked-cost route — sensenova,
 * tokenharbor, custom gateways, anything that might bill — is never
 * auto-touched unless `CODEWHIP_AUTO_INCLUDE_UNTRACKED=1` opts in. Without
 * this, setting a paid key would silently enroll it in random spend.
 */
export function isAutoEligible(providerId: string, model: string): boolean {
  const cfg = getProviderConfig(providerId);
  if (cfg === null) return false;
  if (isLoopbackBaseUrl(cfg.baseUrl)) return false; // auto never guesses at local
  const { key, source } = resolveKey(providerId);
  if (key.length === 0) return false; // auto never routes at a certain 401
  if (source === "anonymous") return true;
  if (estimateCost(providerId as ProviderId, model, 1000, 1000) === 0) return true;
  return process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED === "1";
}

export function pickRandomHealthy(rng: () => number = Math.random): Route | { error: string } {
  const configs = listAllProviderConfigs();
  const summary = summarizeCalls(readProviderCalls());
  const pass: { provider: string; model: string }[] = [];
  const gatedOut: { provider: string; model: string }[] = [];
  for (const cfg of configs) {
    const provider = cfg.id as ProviderId;
    const model = cfg.defaultModel;
    if (!isModelAllowed(provider, model)) continue; // consent gate: exact ids only
    if (!isAutoEligible(cfg.id, cfg.defaultModel)) continue;
    if (isRecentlyFailed(provider, model)) continue;
    const ph = summary.providers.find((p) => p.provider === provider);
    const mh = ph?.models.find((m) => m.model === model);
    (mh === undefined || healthPasses(mh, 0.5) ? pass : gatedOut).push({ provider, model });
  }
  const { pool, exploring } = pickExplorePool(pass, gatedOut, rng);
  if (pool.length === 0) {
    return { error: "auto random: no enabled, healthy provider/model combos available — enable one with: codewhip provider enable <provider>:<model> (see: codewhip provider allowed), or pass --provider to override" };
  }
  const pick = pool[Math.floor(rng() * pool.length)];
  return {
    provider: pick.provider as ProviderId,
    model: pick.model,
    note: exploring
      ? "auto random → exploration probe (health-gated, TTL-respecting)"
      : "auto random → provider health & TTL deactivation",
  };
}

export function routeFor(taskClass: TaskClass, dir?: string): Route | { error: string } {
  if (process.env.CODEWHIP_AUTO_RANDOM === "1") {
    if (taskClass === "private") return localRoute(dir);
    return pickRandomHealthy();
  }
  if (taskClass === "implement") {
    const provider = "nvidia";
    const model = PROVIDERS.nvidia.defaultModel;
    if (!isModelAllowed(provider, model)) {
      return { error: `auto route for 'implement' targets ${provider}:${model}, which is not enabled — run: codewhip provider enable ${provider}:${model}, or pass --provider to override` };
    }
    if (!healthOk(provider, model)) {
      return { error: `auto route for 'implement' skipped ${provider}:${model} due to low success rate — pass --provider to override` };
    }
    return { provider, model, note: "implement → frontier free tier" };
  }
  if (taskClass === "polish") {
    // Priced $0 free-tier hop (verified 2026-09-11; 97% ok over 120 calls
    // per local provider-stats 2026-09-17) — the launch-gate route: priced,
    // so polishGate can actually pass. Keyless anonymous, never bills.
    const provider = "kilo";
    const model = PROVIDERS.kilo.defaultModel;
    if (!isModelAllowed(provider, model)) {
      return { error: `auto route for 'polish' targets ${provider}:${model}, which is not enabled — run: codewhip provider enable ${provider}:${model}, or pass --provider to override` };
    }
    return { provider, model, note: "polish → cheapest inference (priced $0 free tier)" };
  }
  return localRoute(dir);
}

/**
 * The `private` destination. Exactly one registered loopback provider is
 * unambiguous; several is not, and guessing which of them should see your
 * secrets is not a decision this classifier gets to make — so it asks.
 *
 * Loopback targets are exempt from the model allowlist by v1 decision: the
 * registration itself (provider add) is the consent, nothing leaves the
 * machine, and nothing bills.
 */
function localRoute(dir?: string): Route | { error: string } {
  const locals = listLocalProviders(dir);
  if (locals.length === 1) {
    const only = locals[0];
    return {
      provider: only.id,
      model: only.defaultModel,
      note: "private → local runtime (loopback, never leaves this machine)",
    };
  }
  if (locals.length > 1) {
    const ids = locals.map((c) => c.id).join(", ");
    return { error: `private class found ${locals.length} local providers (${ids}) — pass --provider to choose one` };
  }
  return {
    error:
      "private class needs a local provider and none is registered — add one with `codewhip provider add ollama-local " +
      "--base-url http://127.0.0.1:11434 --model qwen3:35b`, or pass --provider explicitly to consent to cloud routing",
  };
}

export type RouteResolution =
  | { provider: ProviderId; model: string; taskClass: TaskClass; auto: boolean; note: string }
  | { error: string };

/**
 * Explicit flags always win. Otherwise classify the prompt and route by
 * class. Returns {error} for private-without-explicit-provider.
 */
export function resolveRoute(opts: {
  prompt: string;
  taskClass?: TaskClass;
  provider?: ProviderId;
  model?: string;
  defaultProvider: ProviderId;
  defaultModel: string;
  /** Config dir for the local-provider lookup; tests inject a temp dir. */
  dir?: string;
}): RouteResolution {
  if (opts.provider !== undefined || opts.model !== undefined) {
    const pid = opts.provider ?? opts.defaultProvider;
    return {
      provider: pid,
      model: opts.model ?? getProviderConfig(pid)?.defaultModel ?? opts.defaultModel,
      taskClass: opts.taskClass ?? classify(opts.prompt).taskClass,
      auto: false,
      note: "explicit --provider/--model override",
    };
  }
  const taskClass = opts.taskClass ?? classify(opts.prompt).taskClass;
  const routed = routeFor(taskClass, opts.dir);
  if ("error" in routed) {
    return routed;
  }
  return {
    provider: routed.provider,
    model: opts.model ?? routed.model,
    taskClass,
    auto: opts.taskClass === undefined,
    note: routed.note,
  };
}

/** Known per-1K-token prices in USD. Missing = untracked (never fiction). */
const PRICE_PER_1K: Partial<Record<string, { input: number; output: number }>> = {
  "nvidia:moonshotai/kimi-k3": { input: 0, output: 0 },
  // Free-chain routes (verified 2026-09-11): the free tier/default free
  // models are real $0 prices. Never price anything off this list.
  "opencode:mimo-v2.5-free": { input: 0, output: 0 },
  "kilo:cohere/north-mini-code:free": { input: 0, output: 0 },
  "openrouter:nvidia/nemotron-3-super-120b-a12b:free": { input: 0, output: 0 },
  "gemini:gemini-2.5-flash": { input: 0, output: 0 },
  "groq:openai/gpt-oss-120b": { input: 0, output: 0 },
  // cerebras dropped 2026-09-13: its grant now needs a verified card and
  // expires in 30 days, so a $0 sticker would be fiction.
  "zai:glm-5.3-flash": { input: 0, output: 0 },
  "empero:glm-5.3-flash": { input: 0, output: 0 },
  // codiv (2026-09-18): free experiment tier — no card and no billing path;
  // an exhausted grant answers 429 insufficient_quota rather than a bill, so
  // $0 is the provider's own sticker, not a guess.
  "codiv:diffusiongemma-26b": { input: 0, output: 0 },
};

export function estimateCost(provider: ProviderId, model: string, prompt: number, completion: number): number | null {
  const p = PRICE_PER_1K[`${provider}:${model}`];
  if (p === undefined) {
    // A loopback runtime is not "untracked" — it genuinely costs nothing
    // marginal, and there is no provider console to go and check. Reporting
    // untracked there would send the user looking for a bill that cannot exist.
    const cfg = getProviderConfig(provider);
    if (cfg !== null && isLoopbackBaseUrl(cfg.baseUrl)) {
      return 0;
    }
    return null;
  }
  return (prompt / 1000) * p.input + (completion / 1000) * p.output;
}

/** Launch gate: a polish receipt proves <$0.05 only when priced, not untracked. */
export function polishGate(cost: number | null): { pass: boolean; reason: string } {
  if (cost === null) {
    return { pass: false, reason: "cost untracked for this provider:model — gate needs a priced route" };
  }
  return cost < 0.05
    ? { pass: true, reason: `polish cost $${cost.toFixed(4)} < $0.05` }
    : { pass: false, reason: `polish cost $${cost.toFixed(4)} ≥ $0.05` };
}

type PolishSignals = Pick<OutcomeRecord, "task_class" | "model" | "usageByModel">;

/**
 * Polish-run detector for `trust`: records written since 2026-09-17 carry
 * task_class; older ones fall back to model-substring markers from each
 * routing era (sensenova/flash/haiku, then kilo :free/north-mini). Never throws.
 */
export function isPolishRun(r: PolishSignals): boolean {
  if (r.task_class !== undefined) return r.task_class === "polish";
  const models = [r.model, ...(r.usageByModel ?? []).map((b) => `${b.label}:${b.model}`)];
  return models.some((m) =>
    m.includes("sensenova") || m.includes("flash") || m.includes("haiku") ||
    m.includes("north-mini") || m.includes(":free") || m.includes("-free"));
}

/**
 * Total a run's priced spend across usageByModel buckets (mirrors metrics);
 * falls back to the bare model id with a first-colon provider split for
 * records without buckets. Null when any leg is untracked — never fiction.
 */
export function polishRunCost(r: Pick<OutcomeRecord, "model" | "usage" | "usageByModel">): number | null {
  const buckets = r.usageByModel;
  if (buckets !== undefined && buckets.length > 0) {
    let total = 0;
    for (const b of buckets) {
      const c = estimateCost(b.label as ProviderId, b.model, b.prompt, b.completion);
      if (c === null) return null;
      total += c;
    }
    return total;
  }
  // Model ids themselves contain colons ("kilo:cohere/north-mini-code:free"),
  // so split on the FIRST one — a naive split prices the wrong key and
  // reports OPEN after a real PASS.
  const sep = r.model.indexOf(":");
  if (sep === -1) return null;
  return estimateCost(r.model.slice(0, sep) as ProviderId, r.model.slice(sep + 1), r.usage.prompt, r.usage.completion);
}