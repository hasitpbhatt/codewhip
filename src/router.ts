import { PROVIDERS, type ProviderId } from "./provider.js";
import { getProviderConfig, isLoopbackBaseUrl, listLocalProviders } from "./custom-providers.js";

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
export function routeFor(taskClass: TaskClass, dir?: string): Route | { error: string } {
  if (taskClass === "implement") {
    return { provider: "nvidia", model: PROVIDERS.nvidia.defaultModel, note: "implement → frontier free tier" };
  }
  if (taskClass === "polish") {
    return { provider: "sensenova", model: PROVIDERS.sensenova.defaultModel, note: "polish → cheapest inference" };
  }
  return localRoute(dir);
}

/**
 * The `private` destination. Exactly one registered loopback provider is
 * unambiguous; several is not, and guessing which of them should see your
 * secrets is not a decision this classifier gets to make — so it asks.
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