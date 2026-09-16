/**
 * Complete Auto-Routing Logic for CodeWhip Proxy
 * 
 * This module contains the full intelligent routing system extracted from the CLI,
 * including:
 * - Task classification (implement/polish/private)
 * - TTL deactivation for failed providers
 * - Health-weighted auto selection
 * - Free-chain ordering
 * - Cost estimation
 * - Polish gate (<$0.05)
 */

// ============================================================================
// Types
// ============================================================================

export type TaskClass = "implement" | "polish" | "private";

export type Route = {
  provider: string;
  model: string;
  note: string;
};

export type RouteResolution =
  | { provider: string; model: string; taskClass: TaskClass; auto: boolean; note: string }
  | { error: string };

import {
  summarizeCalls,
  type ProviderCallRecord,
} from "./health.js";

// ============================================================================
// TTL Deactivation Configuration
// ============================================================================

const TTL_MS = {
  quota: 15 * 60 * 1000,      // 15 minutes
  auth: 60 * 60 * 1000,       // 1 hour
  timeout: 5 * 60 * 1000,     // 5 minutes
  network: 5 * 60 * 1000,     // 5 minutes
  bad_model: 24 * 60 * 60 * 1000, // 24 hours
  other: 5 * 60 * 1000,       // 5 minutes
};

// ============================================================================
// Task Classification
// ============================================================================

const PRIVATE_RX = /\b(password|passwd|passphrase|secret|credential|private key|api[-_ ]?key|access key|signing key|encryption key|master key|ssn|credit card|salary|internal only)s?\b|\b(bearer|auth|access|refresh|session)[-_ ]?tokens?\b|\bprod(uction)?\b.*\b(db|database|password)\b|\b(kubeconfig|connection string|recovery phrase|session cookie|service account)\b|\.env\b/i;
const POLISH_RX = /\b(typo|spelling|format(ting)?|lint|comment(s)?|rename|docs?|readme|polish|grammar|punctuation|whitespace|indent(ation)?)\b/i;

/**
 * ~5-line classifier: private signals win (safety first), then polish signals,
 * else implement. Heuristic, printed with its reason — the user overrides
 * with --class/--provider/--model, which always win.
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

// ============================================================================
// Provider Health & TTL
// ============================================================================

/** Check if a provider/model has recently failed and is still in TTL deactivation. */
export function isRecentlyFailed(
  providerId: string, 
  model: string, 
  records: ProviderCallRecord[]
): boolean {
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return false;
  const mh = ph.models.find((m) => m.model === model);
  if (!mh || !mh.lastFailureTs || !mh.lastFailureOutcome) return false;
  const last = new Date(mh.lastFailureTs).getTime();
  const ttl = TTL_MS[mh.lastFailureOutcome as keyof typeof TTL_MS] ?? 5 * 60 * 1000;
  return Date.now() - last < ttl;
}

/** Check if provider/model is healthy (success rate >= 70% with >=5 calls). */
export function healthOk(
  providerId: string,
  model: string,
  records: ProviderCallRecord[]
): boolean {
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return true; // no data yet
  const mh = ph.models.find((m) => m.model === model);
  if (!mh) return true;
  if (mh.total < 5) return true; // not enough data
  return mh.successRate >= 0.7;
}

/** Check if provider/model has success rate below 50% (with >=5 calls). */
export function isUnhealthy(
  providerId: string,
  model: string,
  records: ProviderCallRecord[]
): boolean {
  const summary = summarizeCalls(records);
  const ph = summary.providers.find((p) => p.provider === providerId);
  if (!ph) return false;
  const mh = ph.models.find((m) => m.model === model);
  if (!mh) return false;
  if (mh.total < 5) return false;
  return mh.successRate < 0.5;
}

// ============================================================================
// Provider Call Records & Health Summarization — re-exported from ./health.js
// (single source of truth: token tracking, NUL-safe keying, listing checks).
export { summarizeCalls, outcomeForStatus } from "./health.js";
export type {
  ProviderCallRecord,
  ProviderCallOutcome,
  ModelHealth,
  ProviderHealth,
  ProviderHealthSummary,
} from "./health.js";

// ============================================================================
// Cost Estimation
// ============================================================================

/** Known per-1K-token prices in USD. Missing = untracked (never fiction). */
const PRICE_PER_1K: Partial<Record<string, { input: number; output: number }>> = {
  "nvidia:meta/llama-3.1-405b-instruct": { input: 0, output: 0 },
  "opencode:mimo-v2.5-free": { input: 0, output: 0 },
  "kilo:cohere/north-mini-code:free": { input: 0, output: 0 },
  "openrouter:nvidia/nemotron-3-super-120b-a12b:free": { input: 0, output: 0 },
  "gemini:gemini-1.5-flash": { input: 0, output: 0 },
  "groq:llama-3.1-70b-versatile": { input: 0, output: 0 },
  "zai:glm-5.3-flash": { input: 0, output: 0 },
  "empero:glm-5.3-flash": { input: 0, output: 0 },
};

export function estimateCost(
  provider: string, 
  model: string, 
  promptTokens: number, 
  completionTokens: number
): number | null {
  const p = PRICE_PER_1K[`${provider}:${model}`];
  if (p === undefined) {
    return null;
  }
  return (promptTokens / 1000) * p.input + (completionTokens / 1000) * p.output;
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

// ============================================================================
// Auto-Eligibility (Paid Key Protection)
// ============================================================================

export type KeySource = "env" | "file" | "anonymous" | "none";

export interface KeyResolver {
  resolveKey(provider: string): { key: string; source: KeySource };
  getProviderConfig(provider: string): ProviderConfig | null;
  isLoopbackBaseUrl(url: string): boolean;
}

/** 
 * Paid-key protection shared by every auto path (CLI and serve).
 * Auto only spends keys that are free by construction:
 * - `anonymous` source — keyless free tiers
 * - a route with a known $0 price
 * A user-supplied key on an untracked-cost route is never auto-touched
 * unless CODEWHIP_AUTO_INCLUDE_UNTRACKED=1 opts in.
 */
export function isAutoEligible(
  providerId: string,
  model: string,
  resolver: KeyResolver
): boolean {
  const cfg = resolver.getProviderConfig(providerId);
  if (cfg === null) return false;
  if (resolver.isLoopbackBaseUrl(cfg.baseUrl)) return false; // auto never guesses at local
  const { key, source } = resolver.resolveKey(providerId);
  if (key.length === 0) return false; // auto never routes at a certain 401
  if (source === "anonymous") return true;
  if (estimateCost(providerId, model, 1000, 1000) === 0) return true;
  return process.env.CODEWHIP_AUTO_INCLUDE_UNTRACKED === "1";
}

// ============================================================================
// Simple Random Auto Selection (CLI style)
// ============================================================================

export function pickRandomHealthy(
  configs: ProviderConfig[],
  records: ProviderCallRecord[],
  resolver: KeyResolver
): Route | { error: string } {
  const candidates: { provider: string; model: string }[] = [];
  for (const cfg of configs) {
    if (!isAutoEligible(cfg.id, cfg.defaultModel, resolver)) continue;
    if (isRecentlyFailed(cfg.id, cfg.defaultModel, records)) continue;
    if (isUnhealthy(cfg.id, cfg.defaultModel, records)) continue;
    candidates.push({ provider: cfg.id, model: cfg.defaultModel });
  }
  if (candidates.length === 0) {
    return { error: "auto random: no healthy provider/model combos available — pass --provider to override" };
  }
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return { provider: pick.provider, model: pick.model, note: "auto random → provider health & TTL deactivation" };
}

// ============================================================================
// Health-Weighted Auto Selection (Serve style)
// ============================================================================

export function pickAutoTarget(
  configs: ProviderConfig[],
  records: ProviderCallRecord[],
  resolver: KeyResolver
): { provider: string; model: string } | { error: string } {
  const summary = summarizeCalls(records);
  const cands: Array<{ provider: string; model: string; weight: number }> = [];
  for (const cfg of configs) {
    if (!isAutoEligible(cfg.id, cfg.defaultModel, resolver)) continue;
    if (isRecentlyFailed(cfg.id, cfg.defaultModel, records)) continue;
    if (isUnhealthy(cfg.id, cfg.defaultModel, records)) continue;
    
    const ph = summary.providers.find((p) => p.provider === cfg.id);
    const mh = ph?.models.find((m) => m.model === cfg.defaultModel);
    const per1k = estimateCost(cfg.id, cfg.defaultModel, 1000, 1000);
    const costFactor = per1k === null ? 0.5 : per1k === 0 ? 3 : 1;
    const healthFactor = mh === undefined ? 1.5 : 0.5 + mh.successRate;
    cands.push({ provider: cfg.id, model: cfg.defaultModel, weight: costFactor * healthFactor });
  }
  if (cands.length === 0) {
    return { error: "auto: no healthy free provider/model combos available — pass an explicit model, add a key for a $0 route, or set CODEWHIP_AUTO_INCLUDE_UNTRACKED=1 to let auto use untracked-cost providers" };
  }
  const total = cands.reduce((a, c) => a + c.weight, 0);
  let r = Math.random() * total;
  for (const c of cands) {
    r -= c.weight;
    if (r <= 0) return { provider: c.provider, model: c.model };
  }
  const last = cands[cands.length - 1];
  return { provider: last.provider, model: last.model };
}

// ============================================================================
// Route Resolution (Complete)
// ============================================================================

function routeFor(taskClass: TaskClass, records: ProviderCallRecord[], resolver: KeyResolver): Route | { error: string } {
  if (taskClass === "private") {
    return localRoute(resolver);
  }
  if (process.env.CODEWHIP_AUTO_RANDOM === "1") {
    return pickRandomHealthy(listAllProviderConfigs(resolver), records, resolver);
  }
  if (taskClass === "implement") {
    const provider = "nvidia";
    const model = getProviderConfig(provider, resolver)?.defaultModel ?? "";
    if (!healthOk(provider, model, records)) {
      return { error: `auto route for 'implement' skipped ${provider}:${model} due to low success rate — pass --provider to override` };
    }
    return { provider, model, note: "implement → frontier free tier" };
  }
  if (taskClass === "polish") {
    const provider = "sensenova";
    const model = getProviderConfig(provider, resolver)?.defaultModel ?? "";
    if (!healthOk(provider, model, records)) {
      return { error: `auto route for 'polish' skipped ${provider}:${model} due to low success rate — pass --provider to override` };
    }
    return { provider, model, note: "polish → cheapest inference" };
  }
  return localRoute(resolver);
}

function localRoute(_resolver: KeyResolver): Route | { error: string } {
  // For now, return error - local providers need explicit config
  return {
    error: "private class needs a local provider and none is registered — add one with provider add, or pass --provider explicitly to consent to cloud routing",
  };
}

/** 
 * Complete route resolution used by both CLI and proxy.
 * Explicit provider/model always wins. Otherwise classify and route by class.
 */
export function resolveRoute(opts: {
  prompt: string;
  taskClass?: TaskClass;
  provider?: string;
  model?: string;
  defaultProvider: string;
  defaultModel: string;
  records: ProviderCallRecord[];
  resolver: KeyResolver;
}): RouteResolution {
  // Explicit flags always win
  if (opts.provider !== undefined || opts.model !== undefined) {
    const pid = opts.provider ?? opts.defaultProvider;
    return {
      provider: pid,
      model: opts.model ?? getProviderConfig(pid, opts.resolver)?.defaultModel ?? opts.defaultModel,
      taskClass: opts.taskClass ?? classify(opts.prompt).taskClass,
      auto: false,
      note: "explicit --provider/--model override",
    };
  }
  
  const taskClass = opts.taskClass ?? classify(opts.prompt).taskClass;
  const routed = routeFor(taskClass, opts.records, opts.resolver);
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

// Helper to get provider config from resolver
function getProviderConfig(provider: string, resolver: KeyResolver): ProviderConfig | null {
  return resolver.getProviderConfig(provider);
}

// Helper to list all provider configs
function listAllProviderConfigs(_resolver: KeyResolver): ProviderConfig[] {
  // This would need to be implemented by the resolver
  // For now return empty - the caller should provide this
  return [];
}

// ============================================================================
// Provider Config Interface (for router)
// ============================================================================

export interface ProviderConfig {
  id: string;
  brand: string;
  baseUrl: string;
  chatPath: string;
  modelsPath: string;
  defaultModel: string;
  envVar: string;
  keyUrl: string;
  timeoutMs: number;
  port?: string;
}