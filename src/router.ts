import { type ProviderId } from "./provider.js";
import { getProviderConfig, isLoopbackBaseUrl, listLocalProviders } from "./custom-providers.js";
import type { OutcomeRecord, UsageBucket } from "./outcomes.js";

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
export function routeFor(taskClass: TaskClass, dir?: string): Route | { error: string } {
  // ponytail: auto routing removed. Explicit --provider is the only way to pick a
  // destination now; private still prefers a lone registered local runtime so a
  // secret-bearing prompt never silently hops to the cloud.
  if (taskClass === "private") return localRoute(dir);
  return { error: "no provider specified - pass --provider <id> (and --model if needed)" };
}


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

export function costNote(provider: string, model?: string): string {
  // Honest meter: only known-$0 routes print $0 — nvidia's free tier and
  // providers verified 2026-09-11 (kilo/openrouter/opencode
  // are $0 only on their free-suffixed models; empero's endpoint is openly
  // free but logs prompts). Everything else bills or caps in provider-
  // specific ways — point at their console, not fiction.
  // cerebras was removed here 2026-09-13: its grant needs a verified card and
  // expires in 30 days, so "$0 (cerebras free tier)" became a fiction.
  if (provider === "nvidia" || provider === "groq" || provider === "gemini" || provider === "zai") {
    return `$0.0000 (${provider} free tier)`;
  }
  if (provider === "empero") {
    return "$0.0000 (empero free endpoint)";
  }
  const m = model ?? "";
  if (provider === "kilo" || provider === "openrouter") {
    if (m.endsWith(":free")) {
      return "$0.0000 (:free model)";
    }
  } else if (provider === "opencode" && m.endsWith("-free")) {
    return "$0.0000 (free model)";
  }
  // A loopback local runtime is genuinely $0 marginal and has NO console to
  // check, so "cost untracked (see provider console)" there sends the user
  // looking for a bill that cannot exist. Keep this branch in step with
  // `estimateCost()` — the receipt and the polish gate read the
  // same route through two different functions, so they can silently disagree.
  const cfg = getProviderConfig(provider);
  if (cfg !== null && isLoopbackBaseUrl(cfg.baseUrl)) {
    return "$0.0000 (local runtime — your own machine)";
  }
  const keyUrl = cfg?.keyUrl;
  return keyUrl !== undefined && keyUrl.length > 0
    ? `cost untracked (see ${keyUrl})`
    : "cost untracked (see provider console)";
}

export function mixReceiptString(buckets: UsageBucket[], provider: ProviderId, model: string): string {
  const list = buckets.length > 0
    ? buckets
    : [{ label: provider, model, prompt: 0, completion: 0 }];
  let p = 0;
  let c = 0;
  const parts: string[] = [];
  const costs: string[] = [];
  for (const b of list) {
    p += b.prompt;
    c += b.completion;
    // "est." is the honest marker for streams that ended without a usage
    // block — never present a chars/4 estimate as a meter reading.
    const est = b.estimated === true ? "est. " : "";
    parts.push(`${b.label}:${b.model} ${est}${b.prompt}+${b.completion}`);
    costs.push(costNote(b.label, b.model));
  }
  return `receipt: ${p} prompt + ${c} completion tokens / ${parts.join(" + ")} / ${costs.join(" + ")}`;
}

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

/**
 * Run-total metered cost, or null when any route in the mix is unpriced.
 * `null` is a fact about the meter, not a zero: a caller must not report an
 * untracked run as free.
 */
export function meteredCost(rows: readonly UsageBucket[]): number | null {
  let total = 0;
  for (const r of rows) {
    const c = estimateCost(r.label, r.model, r.prompt, r.completion);
    if (c === null) return null;
    total += c;
  }
  return total;
}

/** Launch gate: a polish receipt proves <$0.05 only when priced, not untracked. */export function polishGate(cost: number | null): { pass: boolean; reason: string } {
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