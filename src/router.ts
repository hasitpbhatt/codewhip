import { PROVIDERS, type ProviderId } from "./provider.js";
import { getProviderConfig } from "./custom-providers.js";

export type TaskClass = "implement" | "polish" | "private";

export type Route = {
  provider: ProviderId;
  model: string;
  /** Why this route (shown on the receipt line, not sent to the model). */
  note: string;
};

const PRIVATE_RX = /\b(password|passwd|secret|credential|private key|api[-_ ]?key|\.env\b|ssn|credit card|prod(uction)?\b.*\b(db|database|password)|salary|internal only)\b/i;
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
 * Class → provider:model. Implement rides the free capable tier; polish
 * rides the cheapest inference; private wants local — which isn't wired,
 * so it refuses cloud routing unless the user explicitly names a provider
 * (override = informed consent, logged on the receipt line).
 */
export function routeFor(taskClass: TaskClass): Route | { error: string } {
  if (taskClass === "implement") {
    return { provider: "nvidia", model: PROVIDERS.nvidia.defaultModel, note: "implement → frontier free tier" };
  }
  if (taskClass === "polish") {
    return { provider: "sensenova", model: PROVIDERS.sensenova.defaultModel, note: "polish → cheapest inference" };
  }
  return { error: "private class needs a local provider (not wired) — pass --provider explicitly to consent to cloud routing" };
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
  const routed = routeFor(taskClass);
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
  "cerebras:qwen-3-coder-480b": { input: 0, output: 0 },
  "zai:glm-5.3-flash": { input: 0, output: 0 },
  "empero:glm-5.3-flash": { input: 0, output: 0 },
};

export function estimateCost(provider: ProviderId, model: string, prompt: number, completion: number): number | null {
  const p = PRICE_PER_1K[`${provider}:${model}`];
  if (p === undefined) {
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