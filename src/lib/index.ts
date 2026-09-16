/**
 * CodeWhip Proxy Library - Complete Auto-Routing Edition
 *
 * Full provider registry (35+), health-weighted auto-routing,
 * dynamic model discovery, storage abstraction, OpenAI compatibility.
 */

// -- Types -----------------------------------------------------------------
export type {
  ProviderId, ProviderConfig, Target, ServeOptions,
  LoopMsg, LoopToolCall, ToolSpec,
  ChatPortResponse, ChatPort,
  Storage, KeySource,
} from "./types.js";

// -- Providers -------------------------------------------------------------
export {
  PROVIDERS, isBuiltinProviderId, getProviderConfig,
  listBuiltinProviderIds, listBuiltinProviderConfigs,
  FREE_CHAIN, freeChainIds, listFreeProviders,
  listModels, outcomeForStatus,
} from "./providers.js";
export type { AnnotatedModel, ModelsResult } from "./providers.js";

// -- Storage ---------------------------------------------------------------
export {
  NodeStorage, KVStorage, MemoryStorage,
  createStorage, createStorageForBackend,
} from "./storage.js";
export type { StorageConfig } from "./storage.js";

// -- OpenAI protocol -------------------------------------------------------
export {
  toLoopMessages, toToolSpecs, toLoopToolCalls,
  contentToText, completionChoice, statusForError, resolveTarget,
} from "./openai.js";

// -- Auto-routing ----------------------------------------------------------
export {
  classify, isRecentlyFailed, healthOk, isUnhealthy,
  estimateCost, polishGate, isAutoEligible,
  pickRandomHealthy, pickAutoTarget, resolveRoute,
} from "./router.js";
export type {
  TaskClass, Route, RouteResolution,
  ProviderCallRecord, ProviderCallOutcome,
  ModelHealth, ProviderHealth, ProviderHealthSummary,
  KeyResolver,
} from "./router.js";

// -- Health tracking -------------------------------------------------------
export {
  MemoryHealthStorage, KVHealthStorage,
  summarizeCalls, renderProviderHealth, HealthTracker,
} from "./health.js";
export type { HealthStorage } from "./health.js";

// -- Proxy -----------------------------------------------------------------
export { CodeWhipProxy, createProxy } from "./proxy.js";

// -- Version ---------------------------------------------------------------
export const VERSION = "0.2.0";