import { type ProviderId } from "./provider.js";
import { getProviderConfig, isLoopbackBaseUrl } from "./custom-providers.js";
import type { OutcomeRecord, UsageBucket } from "./outcomes.js";

/** Known per-1K-token prices in USD. Missing = untracked (never fiction). */
const PRICE_PER_1K: Partial<Record<string, { input: number; output: number }>> = {
  "nvidia:moonshotai/kimi-k3": { input: 0, output: 0 },
  "opencode:mimo-v2.5-free": { input: 0, output: 0 },
  "kilo:cohere/north-mini-code:free": { input: 0, output: 0 },
  "openrouter:nvidia/nemotron-3-super-120b-a12b:free": { input: 0, output: 0 },
  "gemini:gemini-2.5-flash": { input: 0, output: 0 },
  "groq:openai/gpt-oss-120b": { input: 0, output: 0 },
  "zai:glm-5.3-flash": { input: 0, output: 0 },
  "empero:glm-5.3-flash": { input: 0, output: 0 },
  "codiv:diffusiongemma-26b": { input: 0, output: 0 },
};

/**
 * Human-readable cost note for a provider:model pair. Never fiction — unknown
 * prices return "cost untracked (see …)" pointing to the provider's console.
 */
export function costNote(provider: string, model?: string): string {
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
    const est = b.estimated === true ? "est. " : "";
    parts.push(`${b.label}:${b.model} ${est}${b.prompt}+${b.completion}`);
    costs.push(costNote(b.label, b.model));
  }
  return `receipt: ${p} prompt + ${c} completion tokens / ${parts.join(" + ")} / ${costs.join(" + ")}`;
}

export function estimateCost(provider: ProviderId, model: string, prompt: number, completion: number): number | null {
  const p = PRICE_PER_1K[`${provider}:${model}`];
  if (p === undefined) {
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
  const sep = r.model.indexOf(":");
  if (sep === -1) return null;
  return estimateCost(r.model.slice(0, sep) as ProviderId, r.model.slice(sep + 1), r.usage.prompt, r.usage.completion);
}
