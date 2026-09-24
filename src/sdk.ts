import * as fs from "node:fs";
import * as path from "node:path";
import { makePortForConfig, PROVIDERS, type ProviderId } from "./provider.js";
import type { ChatPort } from "./provider-port.js";
import { getProviderConfig, isLoopbackBaseUrl } from "./custom-providers.js";
import { resolveKey } from "./auth.js";
import { isModelAllowed } from "./model-allowlist.js";
import { costNote, estimateCost, meteredCost, mixReceiptString, resolveRoute, type TaskClass } from "./router.js";
import { agentLoop, type AskContext, type ApprovalAnswer, type LoopEvent, type LoopResult } from "./loop.js";
import type { LoopMsg } from "./provider-port.js";
import { loadSettings, type PermissionMode } from "./settings.js";
import { resolveRoots } from "./tools/jail.js";
import { parseToolFilterList, type ToolFilter } from "./tool-filter.js";
import { listRules } from "./remember-store.js";
import { loadHooks } from "./hooks.js";
import { DEFAULT_COMPACT_TOKENS } from "./compact.js";
import { buildResult, type RunFacts } from "./run-output.js";
import { parseUserMessage } from "./stream-input.js";
import {
  HOST_TOOL_TIMEOUT_MAX_MS,
  HOST_TOOL_TIMEOUT_MIN_MS,
  hostToolProblem,
  type HostToolDef,
} from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import type { UsageBucket } from "./outcomes.js";

/**
 * The programmatic entry (parity doc wave 2: Agent SDK).
 *
 * `query()` runs the same `agentLoop()` the CLI runs, through the same gates,
 * and yields the same machine documents `-p --output-format stream-json`
 * writes — it is a different mouth on one engine, not a second engine. The
 * invariant this file exists to hold: **an SDK run cannot skip a consent gate
 * the CLI enforces.** Route resolution (including the private-without-explicit-
 * provider refusal), the enabled-model allowlist, the key check, the dollar
 * ceiling on an unpriced route, plan mode, hooks loaded before the run exists
 * and the non-overridable ask ladder are all reached here, in that order,
 * before a token is spent.
 *
 * Three things are deliberately NOT offered, because each would weaken a
 * guarantee rather than the API:
 *
 * - `updatedInput` on a permission decision. The policy verdict, the audit
 *   `args_hash` and the remembered shape are all graded against ONE string;
 *   rewriting arguments after that grading would make the trail describe bytes
 *   that were never executed.
 * - A host-supplied deny message handed to the model. A refusal reason from the
 *   caller's process is a new injection path into the transcript, and the
 *   loop's own refusal text is already audited.
 * - Any way to talk past a deny. `canUseTool` is mounted on the `ask` rung of
 *   the ladder, so a policy deny, plan mode, the denylist and `disallowedTools`
 *   never call it — a host decider can refuse more, never less.
 */

/** Everything the ask rung knows, handed over beside the display string. */
export type PermissionAskContext = AskContext;

export type PermissionResult =
  /**
   * `scope` names which rung the consent stops on: `once` (default) is this
   * call only, `session` allows the same shape for the rest of this run,
   * `always` writes a repo rule the NEXT run reads — so a host that means
   * "remember this" has to say so, and the audit actor stays truthful.
   */
  | { behavior: "allow"; scope?: "once" | "session" | "always" }
  | { behavior: "deny"; message?: string };

export type CanUseTool = (
  tool: string,
  input: Record<string, unknown>,
  ctx: PermissionAskContext
) => PermissionResult | Promise<PermissionResult>;

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { cwd: string; signal?: AbortSignal }
) => string | ToolResult | Promise<string | ToolResult>;

/** `tool()` input — the human-friendly shape of a host-provided tool. */
export type SdkTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
  timeoutMs?: number;
};

export type QueryOptions = {
  /** `"provider:model"`, or a bare model id together with `provider`. */
  model?: string;
  provider?: string;
  cwd?: string;
  /** Step ceiling for one turn — the CLI's `--max-steps`, same 1..100 bound. */
  maxTurns?: number;
  taskClass?: TaskClass;
  permissionMode?: PermissionMode;
  plan?: boolean;
  yolo?: boolean;
  /** Comma-separated or a list — the exact `--allowed-tools` grammar. */
  allowedTools?: string | readonly string[];
  disallowedTools?: string | readonly string[];
  /** Host-provided tools, built with `tool()`. */
  tools?: readonly SdkTool[];
  canUseTool?: CanUseTool;
  appendSystemPrompt?: string;
  tokenBudget?: number;
  maxBudgetUsd?: number;
  /** Same-provider rotation on rate-limit/timeout/5xx (model ids, head first). */
  fallbackModels?: string[];
  signal?: AbortSignal;
  /**
   * Supply the transport instead of resolving one — for tests and for an
   * adapter this package does not ship. It replaces the provider/key lookup
   * only, so `provider` must still be named. It is not a way around the
   * ladder: policy, audit, budgets and the ask rung are downstream of this
   * field either way, and `dist/loop.js` has never been a secret. This is a
   * convenience, not a privilege boundary.
   */
  port?: ChatPort;
  /** Config dir for the allowlist/route lookup; tests inject a temp dir. */
  dir?: string;
};

export type SdkInitMessage = {
  type: "system";
  subtype: "init";
  provider: string;
  model: string;
  task_class: string;
  permission_mode: string;
  custom_tools: string[];
  max_turns: number;
  cwd: string;
  multi_turn: boolean;
};

export type SdkEventMessage = { type: "event"; kind: LoopEvent["kind"]; text: string };

export type SdkMessage = SdkInitMessage | SdkEventMessage | Record<string, unknown>;

export type Query = AsyncIterable<SdkMessage> & {
  /** Stop the run: aborts provider calls and in-flight tool execs. */
  interrupt(): void;
};

/** Thrown before the loop starts — a refused call never contacts a provider. */
export class SdkError extends Error {}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Describe a tool the model may call. Validated eagerly and loudly: a tool that
 * cannot be described cannot be executed, and a host tool that shadowed a
 * builtin would read a policy row it does not belong to.
 *
 * A host tool has no policy row, so it asks every time, is never remembered by
 * the harness, is refused while running as a `delegate` subagent and is refused
 * by plan mode. It is still screened by the denylist and by `policy.md` denies.
 */
export function tool(def: SdkTool): SdkTool {
  const problem = sdkToolProblem(def);
  if (problem !== null) throw new SdkError(`tool(): ${problem}`);
  return def;
}

/** The registry's shape check plus the one thing only a host body can get wrong. */
function sdkToolProblem(def: SdkTool): string | null {
  const shape = hostToolProblem(asHost(def));
  if (shape !== null) return shape;
  return typeof def.handler === "function" ? null : `"${def.name}" has no handler`;
}

function asHost(def: SdkTool): HostToolDef {
  return {
    name: def.name,
    spec: { name: def.name, description: def.description, parameters: def.inputSchema },
    timeoutMs: def.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    exec: async (ctx, args, signal) => {
      const out = await def.handler(args as Record<string, unknown>, { cwd: ctx.cwd, signal });
      return typeof out === "string" ? { ok: true, output: out } : out;
    },
  };
}

function filtersOf(raw: string | readonly string[] | undefined, what: string): ToolFilter[] {
  if (raw === undefined) return [];
  const joined = typeof raw === "string" ? raw : raw.join(",");
  if (joined.trim().length === 0) return [];
  const parsed = parseToolFilterList(joined);
  if (!parsed.ok) throw new SdkError(`${what}: ${parsed.error}`);
  return parsed.filters;
}

/** What `query()` resolved before the first turn — built once, reused per turn. */
type Prepared = {
  cwd: string;
  provider: ProviderId;
  model: string;
  taskClass: TaskClass;
  port: ChatPort;
  mode: PermissionMode;
  roots: readonly string[];
  hosts: HostToolDef[];
  allowed: ToolFilter[];
  disallowed: ToolFilter[];
  maxSteps: number;
  compactTokens: number;
  askUser: ((question: string, ctx?: AskContext) => Promise<ApprovalAnswer>) | undefined;
  appendSystemPrompt: string;
  fallbackModels: string[];
  tokenBudget?: number;
  maxBudgetUsd?: number;
  signal: AbortSignal;
};

function prepare(options: QueryOptions, promptText: string, signal: AbortSignal): Prepared {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    throw new SdkError(`cwd "${cwd}" is not a directory`);
  }
  const maxTurns = options.maxTurns ?? 25;
  if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 100) {
    throw new SdkError("maxTurns must be an integer between 1 and 100");
  }
  const hosts = (options.tools ?? []).map((t) => {
    const problem = sdkToolProblem(t);
    if (problem !== null) throw new SdkError(`tools: ${problem}`);
    return asHost(t);
  });

  let provider = options.provider;
  let model = options.model;
  if (model !== undefined && provider === undefined && model.includes(":")) {
    const sep = model.indexOf(":");
    provider = model.slice(0, sep);
    model = model.slice(sep + 1);
  }
  if (options.port !== undefined && provider === undefined) {
    throw new SdkError("a custom port must name its provider");
  }
  if (options.port === undefined && model !== undefined && provider === undefined) {
    throw new SdkError(`model "${model}" names no provider — pass "provider:model" or set provider`);
  }

  const routed = resolveRoute({
    prompt: promptText,
    taskClass: options.taskClass,
    provider: provider as ProviderId | undefined,
    model,
    defaultProvider: "nvidia",
    defaultModel: PROVIDERS.nvidia.defaultModel,
    ...(options.dir === undefined ? {} : { dir: options.dir }),
  });
  if ("error" in routed) throw new SdkError(`route refused: ${routed.error}`);
  const pid = routed.provider;
  const mid = routed.model;

  let port = options.port;
  let contextWindow: number | undefined;
  if (port === undefined) {
    const cfg = getProviderConfig(pid);
    if (cfg === null) throw new SdkError(`unknown provider "${pid}" (see: codewhip provider list)`);
    contextWindow = cfg.contextWindow;
    // The same consent gate `serve` and the CLI enforce: no exact enabled
    // entry, no run. Loopback locals are exempt (registering one is consent).
    if (!isLoopbackBaseUrl(cfg.baseUrl) && !isModelAllowed(pid, mid, options.dir)) {
      throw new SdkError(`model "${pid}:${mid}" is not enabled — run: codewhip provider enable ${pid}:${mid}`);
    }
    const { key, source } = resolveKey(pid);
    if (key.length === 0) {
      throw new SdkError(`no key for ${pid} — run: codewhip auth login ${pid} (or pick a keyless provider)`);
    }
    port = makePortForConfig(cfg, key, undefined, source);
  }

  const settings = loadSettings(cwd);
  const mode: PermissionMode =
    options.permissionMode
    ?? (options.plan ? "plan" : options.yolo ? "bypassPermissions" : settings.defaultMode ?? "default");
  const roots = resolveRoots(settings.additionalDirs, cwd).roots;
  if (options.maxBudgetUsd !== undefined && estimateCost(pid, mid, 1000, 1000) === null) {
    throw new SdkError(
      `maxBudgetUsd refused: ${pid}:${mid} is unpriced (cost untracked) — cap tokens with tokenBudget`
    );
  }

  return {
    cwd,
    provider: pid,
    model: mid,
    taskClass: routed.taskClass,
    port,
    mode,
    roots,
    hosts,
    allowed: filtersOf(options.allowedTools, "allowedTools"),
    disallowed: filtersOf(options.disallowedTools, "disallowedTools"),
    maxSteps: maxTurns,
    compactTokens: contextWindow !== undefined
      ? Math.min(DEFAULT_COMPACT_TOKENS, Math.floor(contextWindow * 0.7))
      : DEFAULT_COMPACT_TOKENS,
    askUser: options.canUseTool === undefined ? undefined : askUserFor(options.canUseTool),
    appendSystemPrompt: options.appendSystemPrompt ?? "",
    fallbackModels: options.fallbackModels ?? [],
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
    ...(options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: options.maxBudgetUsd }),
    signal,
  };
}

/**
 * Mount `canUseTool` on the ask rung. The question string is passed through
 * untouched — the display text belongs to the terminal — and the decision is
 * made on `ctx`, whose `subject` is the exact value policy and audit graded.
 * Anything the decider fails to answer correctly is a deny: the rung it was
 * asked about is the safe reading of a bug in the caller.
 */
function askUserFor(canUseTool: CanUseTool): (question: string, ctx?: AskContext) => Promise<ApprovalAnswer> {
  return async (_question, ctx) => {
    if (ctx === undefined) return "no";
    let r: PermissionResult;
    try {
      r = await canUseTool(ctx.tool, ctx.args as Record<string, unknown>, ctx);
    } catch {
      return "no";
    }
    if (typeof r !== "object" || r === null) return "no";
    if (r.behavior !== "allow") return "no";
    return r.scope === "always" ? "always" : r.scope === "session" ? "session" : "yes";
  };
}

function factsFor(p: Prepared, r: LoopResult, durationMs: number): RunFacts {
  return {
    provider: p.provider,
    model: p.model,
    taskClass: p.taskClass,
    durationMs,
    receipt: mixReceiptString(r.usageByModel, p.provider, p.model),
    costUsd: meteredCost(r.usageByModel),
    costNote: (r.usageByModel.length > 0
      ? r.usageByModel.map((b) => costNote(b.label, b.model))
      : [costNote(p.provider, p.model)]).join(" + "),
    ...(p.tokenBudget === undefined ? {} : { tokenBudget: p.tokenBudget }),
    ...(p.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: p.maxBudgetUsd }),
  };
}

function turnCostCheck(p: Prepared, spent: () => number): (buckets: UsageBucket[]) => { stopReason: "error" | "cost_budget"; message: string } | null {
  const cap = p.maxBudgetUsd;
  return (buckets) => {
    let metered = spent();
    for (const b of buckets) {
      const c = estimateCost(b.label, b.model, b.prompt, b.completion);
      if (c === null) {
        // The ceiling is a contract; an unpriced hop breaks it, so stop rather
        // than overspend unmeasured.
        return {
          stopReason: "error",
          message: `maxBudgetUsd ${cap} cannot be metered: ${b.label}:${b.model} is unpriced — partial transcript kept`,
        };
      }
      metered += c;
    }
    return metered > (cap ?? 0)
      ? { stopReason: "cost_budget", message: `cost budget exhausted ($${metered.toFixed(4)}/$${cap}) — partial transcript kept` }
      : null;
  };
}

/** One turn, streamed: yields its events live, returns its LoopResult. */
async function* streamTurn(
  p: Prepared,
  prompt: string,
  history: LoopMsg[],
  tokenBudget: number | undefined,
  spent: () => number
): AsyncGenerator<SdkEventMessage, LoopResult, void> {
  const queue = makeMessageQueue<SdkEventMessage>();
  let result: LoopResult | undefined;
  let failure: unknown;
  const running = agentLoop({
    prompt,
    model: p.model,
    label: p.provider,
    taskClass: p.taskClass,
    cwd: p.cwd,
    maxSteps: p.maxSteps,
    yolo: p.mode === "bypassPermissions",
    // An SDK process is never a terminal: with no canUseTool the loop holds
    // every ask and denies it, exactly as a non-TTY CLI run does.
    stdinIsTTY: false,
    port: p.port,
    signal: p.signal,
    ...(p.askUser === undefined ? {} : { askUser: p.askUser, askUserIsHost: true }),
    remembered: listRules(p.cwd),
    planMode: p.mode === "plan",
    permissionMode: p.mode,
    roots: p.roots,
    allowedTools: p.allowed,
    disallowedTools: p.disallowed,
    ...(p.hosts.length === 0 ? {} : { customTools: p.hosts }),
    ...(p.appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt: p.appendSystemPrompt }),
    ...(p.fallbackModels.length === 0 ? {} : { models: p.fallbackModels }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }),
    ...(p.maxBudgetUsd === undefined ? {} : { costCheck: turnCostCheck(p, spent) }),
    compactTokens: p.compactTokens,
    history,
    // Loaded per turn, before that turn exists: a host cannot arm a hook
    // mid-run any more than the model can.
    hooks: loadHooks(p.cwd),
    onEvent: (e) => queue.push({ type: "event", kind: e.kind, text: e.text }),
  }).then(
    (r) => { result = r; },
    (err: unknown) => { failure = err; }
  ).finally(() => queue.close());
  for (;;) {
    const next = await queue.take();
    if (next.done === true) break;
    yield next.value as SdkEventMessage;
  }
  await running;
  if (failure !== undefined) throw failure;
  if (result === undefined) throw new SdkError("turn ended without a result");
  return result;
}

/** Push/pull bridge: the loop pushes events, the generator pulls them. */
function makeMessageQueue<T>(): {
  push: (v: T) => void;
  close: () => void;
  take: () => Promise<{ done: false; value: T } | { done: true; value: undefined }>;
} {
  const pending: T[] = [];
  let waiter: ((r: { done: false; value: T } | { done: true; value: undefined }) => void) | null = null;
  let closed = false;
  return {
    push: (v) => {
      if (closed) return;
      const w = waiter;
      waiter = null;
      if (w !== null) w({ done: false, value: v });
      else pending.push(v);
    },
    close: () => {
      if (closed) return;
      closed = true;
      const w = waiter;
      waiter = null;
      if (w !== null) w({ done: true, value: undefined });
    },
    take: () => pending.length > 0
      ? Promise.resolve({ done: false as const, value: pending.shift() as T })
      : closed
        ? Promise.resolve({ done: true as const, value: undefined })
        : new Promise((resolve) => { waiter = resolve; }),
  };
}

/** The stream-json grammar for one inbound message, or a bare string. */
function turnText(item: string | unknown): string {
  if (typeof item === "string") return item;
  const parsed = parseUserMessage(JSON.stringify(item));
  if (!parsed.ok) throw new SdkError(`prompt stream: ${parsed.error}`);
  return parsed.text;
}

/**
 * Run one prompt — or an async stream of prompts, which becomes several turns
 * of ONE session in this process — and yield the documents
 * `--output-format stream-json` writes: an `init`, every in-run `event`, then a
 * `result` per turn.
 *
 * Budgets are process-scoped across turns, so N turns cannot spend N times the
 * cap; the route and the permission mode are pinned by the first turn, because
 * consent given for one prompt does not extend to prompts that arrive later.
 * A gate that refuses throws from the first iteration, before any call.
 */
export function query(params: {
  prompt: string | AsyncIterable<string | unknown>;
  options?: QueryOptions;
}): Query {
  const ctrl = new AbortController();
  const outer = params.options?.signal;
  if (outer !== undefined) {
    if (outer.aborted) ctrl.abort();
    else outer.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  let stream: AsyncGenerator<SdkMessage> | null = null;
  return {
    [Symbol.asyncIterator]: () => (stream ??= runTurns(params.options ?? {}, params.prompt, ctrl.signal)),
    interrupt: () => ctrl.abort(),
  };
}

async function* runTurns(
  options: QueryOptions,
  prompt: string | AsyncIterable<string | unknown>,
  signal: AbortSignal
): AsyncGenerator<SdkMessage> {
  const multiTurn = typeof prompt !== "string";
  const inbound = multiTurn
    ? (prompt as AsyncIterable<string | unknown>)[Symbol.asyncIterator]()
    : null;
  let first = "";
  if (inbound !== null) {
    for (;;) {
      const next = await inbound.next();
      if (next.done === true) throw new SdkError("prompt stream carried no user message");
      const text = turnText(next.value);
      if (text.trim().length > 0) { first = text; break; }
    }
  } else {
    first = prompt as string;
  }

  const p = prepare(options, first, signal);
  yield {
    type: "system",
    subtype: "init",
    provider: p.provider,
    model: p.model,
    task_class: p.taskClass,
    permission_mode: p.mode,
    custom_tools: p.hosts.map((h) => h.name),
    max_turns: p.maxSteps,
    cwd: p.cwd,
    multi_turn: multiTurn,
  } satisfies SdkInitMessage;

  let spentCost = 0;
  let spentTokens = 0;
  let history: LoopMsg[] = [];
  let text: string | null = first;
  while (text !== null) {
    const startedAt = Date.now();
    const budget = p.tokenBudget === undefined ? undefined : Math.max(1, p.tokenBudget - spentTokens);
    const result = yield* streamTurn(p, text, history, budget, () => spentCost);
    spentCost += meteredCost(result.usageByModel) ?? 0;
    spentTokens += result.promptTokens + result.completionTokens;
    history = result.messages.slice(1);
    yield buildResult(result, factsFor(p, result, Date.now() - startedAt));
    if (inbound === null) return;
    // A turn that did not finish is not a session to continue: the remaining
    // input is left unread, the same way the CLI stops at the first failure.
    if (result.cancelled || result.stopReason !== "complete") return;
    if (signal.aborted) return;
    if (p.tokenBudget !== undefined && spentTokens >= p.tokenBudget) return;
    if (p.maxBudgetUsd !== undefined && spentCost >= p.maxBudgetUsd) return;
    text = null;
    for (;;) {
      const next = await inbound.next();
      if (next.done === true) return;
      const t = turnText(next.value);
      if (t.trim().length > 0) { text = t; break; }
    }
  }
}

export { HOST_TOOL_TIMEOUT_MIN_MS, HOST_TOOL_TIMEOUT_MAX_MS };
