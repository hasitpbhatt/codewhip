import type { ChatPort, LoopMsg } from "./provider-port.js";
import { TOOLS, hostToolProblem, toolSpecs, type HostToolDef, type ToolDef } from "./tools/registry.js";
import { isToolName, type ToolName, type ToolResult } from "./tools/types.js";
import { checkPermission, permissionSubject } from "./policy.js";
import { loadPromotedDenies } from "./policy-store.js";
import { argsHash, sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";
import { appendOutcome, newRunId, promptHash, type FailoverRecord, type OutcomeToolCall, type UsageBucket } from "./outcomes.js";
import { appendEntry, type AuditActor } from "./audit.js";
import { composeSystemPrompt } from "./system.js";
import { delegationBlind, describeToolFilter, matchToolFilter } from "./tool-filter.js";
import type { ToolFilter } from "./tool-filter.js";
import { shapeOf, declineShape, targetsSelfProtected } from "./remember.js";
import { webfetchOrigin } from "./tools/webfetch.js";
import { persistRule, type RememberedRule } from "./remember-store.js";
import type { PermissionMode } from "./settings.js";
import { jailPath } from "./tools/jail.js";
import { captureBefore, saveCheckpoint } from "./checkpoints.js";
import { compactTranscript, estimateTokens, DEFAULT_COMPACT_TOKENS } from "./compact.js";
import { listAgentsWithErrors } from "./subagents.js";
import { MAX_REPAIRS, repairNote, structuredInstruction, structuredTurn } from "./structured.js";
import { runHooksFor, type HookDeps, type LoadedHooks } from "./hooks.js";
import { NOOP_DEBUG, type Debug } from "./debug.js";
import type { ProviderId } from "./provider-port.js";

export type ApprovalAnswer = "yes" | "session" | "always" | "no";

/**
 * What an ask is actually about, handed to the answerer beside the formatted
 * question. The CLI ignores it and reads its own keypress; a programmatic
 * caller (`canUseTool` in `src/sdk.ts`) decides on these fields instead of
 * parsing a display string. `subject` is the same value the policy verdict and
 * the audit entry were graded against — never a rewritten replacement.
 */
export type AskContext = {
  tool: string;
  subject: string;
  preview: string;
  args: unknown;
  /** The rule that produced the ask, e.g. `default:edit:ask`. */
  ruleId: string;
  runId: string;
  step: number;
  seq: number;
};

export type AskUser = (question: string, ctx?: AskContext) => Promise<ApprovalAnswer>;

export type LoopEvent = {
  kind: "tool" | "retry" | "failover" | "policy" | "compact" | "hook";
  text: string;
};

export type FailoverTarget = {
  label: ProviderId;
  model: string;
  port: ChatPort;
};

/**
 * Tools whose output depends only on (args, workspace bytes): safe to memo
 * within a run. The mutating/authority-bearing tools are deliberately absent —
 * bash can change the tree, and a cached deny would fight the in-run
 * remembered-rule path (an `a` answer promotes a shape after the deny).
 */
const IDEMPOTENT_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>(["read", "search", "webfetch"]);
/** Identical repeats of one call allowed before the answer is replaced by a nudge. */
const REPEAT_NUDGE_AT = 3;

export type LoopArgs = {
  prompt: string;
  model: string;
  /** Primary provider label for receipts (e.g. "nvidia"). */
  label: ProviderId;
  /** Routing class this run was dispatched under (recorded to outcomes when set). */
  taskClass?: string;
  cwd: string;
  maxSteps: number;
  yolo: boolean;
  stdinIsTTY: boolean;
  /**
   * The answerer is a host callback in this process (`canUseTool` in
   * `src/sdk.ts`) rather than a terminal reading stdin, so the non-interactive
   * rung does not apply: an in-process decider needs no TTY to answer. The CLI
   * never sets it; an ask still goes nowhere without `askUser`.
   */
  askUserIsHost?: boolean;
  port: ChatPort;
  signal?: AbortSignal;
  askUser?: AskUser;
  /** One bounded Retry-After wait per run (off unless explicitly armed). */
  retryWait?: boolean;
  /**
   * Ordered cross-provider failover chain (off unless armed). On
   * rate-limited/timeout/server turns, after same-provider rotation is exhausted,
   * the loop hops to the NEXT unused target; each target at most once per
   * run, transcript carries over. Auth/other failures never hop.
   */
  failovers?: FailoverTarget[];
  /**
   * Quiet failover (`--auto-failover`): hop without terminal noise. The
   * failoverTrail (from/to/reason per hop) is still recorded on the outcome
   * and the usage receipt still splits per model — the hops stay on the
   * audited record, they just aren't printed live. Terminal exhaustion still
   * reports what was tried (actionable failure, not backend noise).
   */
  quietFailover?: boolean;
  /**
   * Ordered same-provider model candidates, head first (head === model).
   * Empty by default (no rotation). Each candidate is tried at most once
   * per run, on rate-limited/timeout/server turns only — never on auth/other failures.
   */
  models?: string[];
  /**
   * Live model switch (TUI /model): consulted at each turn boundary, before
   * the step begins. Returning a target swaps the active label/model/port
   * for that turn — the same shape failover assigns to `current`; receipts
   * bucket usage per model, so the switch shows up as an extra mix row.
   * Null = nothing pending.
   */
  takePendingSwitch?: () => FailoverTarget | null;
  /** Hard token ceiling for the whole run (prompt+completion). Off when undefined. */
  tokenBudget?: number;
  /**
   * Dollar ceiling, evaluated by the surface after each billed turn: pricing
   * lives in `router.ts` (surface), and core must not import the surface
   * (`src/boundary.test.ts`), so the check arrives as a callback. Return null
   * to keep going, or a reason to stop the run with the partial transcript.
   */
  costCheck?: (buckets: UsageBucket[]) => { stopReason: StopReason; message: string } | null;
  /**
   * Est-token ceiling for a single provider call (chars/4 estimate).
   * When the transcript crosses it, oldest tool outputs are truncated and
   * old exchanges elided (committee ruling 3) with an honest receipt.
   * undefined = DEFAULT_COMPACT_TOKENS; 0 disables compaction.
   */
  compactTokens?: number;
  /**
   * Run-scoped read-only mode (committee ruling 2): edit/write/bash are
   * refused by the harness before the permission ladder — ask, --yolo, and
   * remembered rules can never grant them. Read/search/webfetch stay
   * allowed for research; the run's output is the plan.
   */
  planMode?: boolean;
  /**
   * `--permission-mode` (and `permissions.defaultMode` in settings): which rung
   * an ASK terminates on. It outranks `--yolo` when both are given — the
   * explicit mode is the more specific instruction, and every mode that
   * outranks yolo here is the less permissive reading. Nothing in this field
   * reaches above the ladder: the denylist, `--disallowed-tools` and the
   * self-protected guard all still refuse.
   */
  permissionMode?: PermissionMode;
  /**
   * Extra jail roots for this run (`--add-dir`, settings
   * `permissions.additionalDirectories`). Realpath'd directories the file
   * tools may also reach; containment only — secret-file and self-protected
   * checks apply inside them.
   */
  roots?: readonly string[];
  /**
   * `--allowed-tools`: shapes the human named on the command line for THIS run
   * only. Consulted inside the ask branch, so it can pre-empt a prompt but
   * never a policy deny, never plan mode, and never a self-protected path.
   */
  allowedTools?: ToolFilter[];
  /**
   * `--disallowed-tools`: shapes refused before the ladder, so no grant — not
   * `--yolo`, not a remembered rule, not a human yes — can let them through.
   * A bare tool name also removes its spec, so the model is never offered a
   * call this run refuses.
   */
  disallowedTools?: ToolFilter[];
  /** `--append-system-prompt[-file]` — the human's own text, appended last. */
  appendSystemPrompt?: string;
  /** `--exclude-dynamic-system-prompt-sections` — drop the agent roster. */
  excludeDynamicSections?: boolean;
  /**
   * `--json-schema` — a parsed schema the final answer must satisfy. The
   * instruction to answer in JSON is appended to the system prompt by the
   * loop (not the caller: it is a harness note, not operator text), and one
   * repair round is spent asking for it before the run reports failure.
   */
  structuredSchema?: unknown;
  /** Bootstrap list of remembered rules (index.ts loads once; loop appends on `a`). */
  remembered?: RememberedRule[];
  /**
   * Prior transcript for `--continue` (system-stripped, post-compaction —
   * the honest tail). Seeded between the fresh system message and the new
   * user prompt: system → history → user. Callers strip any stored system
   * message; the loop trusts what it is given.
   */
  history?: LoopMsg[];
  /** Progress listener (index.ts prints). Never throws into the loop. */
  onEvent?: (event: LoopEvent) => void;
  /**
   * `--debug`: the decisions the terminal never sees — which ladder rung
   * answered, why rotation was skipped, what the transcript weighed at each
   * metering point, what a hook returned. Off unless armed. The sink owns
   * redaction; the loop only owns the sentences.
   */
  debug?: Debug;
  /** Delegation depth: 0 = top-level run (may delegate), >= 1 = subagent (read-only, no delegate tools). */
  depth?: number;
  /** Child system prompt override (subagent bodies). Default: the main SYSTEM_PROMPT. */
  systemPrompt?: string;
  /** Set on child runs: the delegating parent's runId (outcomes attribution —
   * child spend is folded into the parent's record; aggregators de-dup on this). */
  parentRunId?: string;
  /**
   * Bench-only ablation: "prompt" moves policy CONTENT (denylist patterns +
   * promoted denies) out of the harness into the system prompt, which the
   * bench composes. Structural denies (shell chaining, worktree escape) and
   * the ask ladder stay harness-side in every arm. Default "harness".
   */
  policySurface?: "harness" | "prompt";
  /** Bench-only ablation: false disables the run's idempotent-call memo and
   * repeat nudge (RQ5 overthinking arm). Default true. */
  repeatGuard?: boolean;
  /**
   * Hooks loaded ONCE at run start (index.ts). Undefined = no hooks this
   * run; child runs never receive them (v1 — children are effect-free).
   */
  hooks?: LoadedHooks;
  /** Spawner override for hooks (tests/bench only — production spawns shells). */
  hookDeps?: HookDeps;
  /**
   * Caller-supplied tools (the programmatic entry's `tool()`). They ride the
   * same ladder, the same audit chain and the same redaction as a builtin —
   * which means they inherit the fail-closed defaults too: no policy row of
   * their own (`default:host-tool:ask`), never a remembered shape, refused by
   * plan mode, and refused inside a child run (whose whole authority is
   * read+search, so a host tool there would be mutating by proxy).
   */
  customTools?: readonly HostToolDef[];
};

export type LoopTraceCall = {
  seq: number;
  tool: string;
  policy: string;
  actor: AuditActor;
  /** Redacted output/deny preview (capped) — safe to embed in a share bundle. */
  preview: string;
  /** Permission subject (command/path/origin) for decision-log grading; ""
   * for bad calls where no subject could be parsed. */
  subject: string;
};

/** Why the loop exited — the structured counterpart to the `error` string. */
export type StopReason = "complete" | "max_steps" | "token_budget" | "cost_budget" | "error" | "cancelled";

export type LoopResult = {
  text: string;
  runId: string;
  error?: string;
  stopReason: StopReason;
  promptTokens: number;
  completionTokens: number;
  usageByModel: UsageBucket[];
  waitedMs: number;
  failovers: FailoverRecord[];
  steps: number;
  toolCalls: number;
  trace: LoopTraceCall[];
  cancelled: boolean;
  /** Files snapshotted pre-edit/write this run (undo via codewhip rollback). */
  checkpoints: number;
  /** Compaction tally: honest receipt for transcript pruning (ruling 3). */
  compact: { events: number; truncated: number; dropped: number };
  /** Identical idempotent calls served from the run memo instead of re-executing. */
  repeatCalls: number;
  /** `--json-schema`: verdict on the final answer, absent when no schema was set. */
  structured?: { ok: true; value: unknown } | { ok: false; errors: string[] };
  /** Repair rounds spent on the structured answer (absent unless one was used). */
  structuredRepairs?: number;
  /** Audit entries this run failed to record (lock contention / disk) — nonzero means history has holes. */
  auditDropped?: number;
  /**
   * Final transcript (post-compaction) on every exit path — success, error,
   * cancel. `--continue` persists `messages.slice(1)` (system rebuilt fresh
   * on resume); the saved copy is exactly what the last provider call saw.
   */
  messages: LoopMsg[];
  /**
   * What the run put on the wire before the model answered a single token:
   * the system prompt, the advertised tool specs, and the ceiling compaction
   * keeps the transcript under. Reported, never recomputed by the caller — a
   * context grid assembled from a second guess at these three numbers would
   * drift from the run it claims to describe.
   */
  contextShape: { system: number; tools: number; ceiling: number };
};

/**
 * A tool call resolves against the twelve builtins first, then this run's
 * host tools. Nothing else can enter: the registry is not mutable at run
 * time, so a name either has a checked definition or the call is refused as
 * unknown.
 */
function lookupTool(name: string, hosts: ReadonlyMap<string, HostToolDef>): ToolDef | HostToolDef | null {
  if (isToolName(name)) return TOOLS[name];
  return hosts.get(name) ?? null;
}

function previewForLog(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) {
    return String(args).slice(0, 200);
  }
  const r = args as Record<string, unknown>;
  const v = r["command"] ?? r["path"] ?? r["query"] ?? r["url"] ?? args;
  return String(typeof v === "string" ? v : JSON.stringify(args)).slice(0, 200);
}

/**
 * Promise-level wall clock for a tool call with PROCESS-level teeth: when
 * `ms` elapses (or `outer` aborts) the run receives an aborted AbortSignal
 * so self-bounded tools (bash via execFile `signal`) actually kill their
 * child instead of racing silently. Never interrupts main-thread sync work
 * (read/search crawl a big tree in one tick — bounded by their own caps).
 */
export async function withTimeout(
  run: (signal: AbortSignal) => Promise<ToolResult>,
  ms: number,
  outer?: AbortSignal
): Promise<ToolResult> {
  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (outer?.aborted === true) {
    controller.abort();
  } else if (outer !== undefined) {
    outer.addEventListener("abort", onOuterAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const fallback: ToolResult = { ok: false, output: `tool: timed out after ${ms}ms` };
  const timed = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve(fallback);
    }, ms);
  });
  try {
    const result = await Promise.race([run(controller.signal), timed]);
    // Timeout wins when the tool settles on the same tick as the clock.
    return timedOut ? fallback : result;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (outer !== undefined) outer.removeEventListener("abort", onOuterAbort);
  }
}

/** Abortable sleep: true when fully slept, false when cancelled (instant). */
function sleepMs(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Central tool-output cap at transcript push time (read lists, bash dumps). */
const TOOL_OUTPUT_CAP = 4000;
/** Max agents named in the run's system-message roster (token hygiene). */
const MAX_ROSTER = 32;

function capOutput(text: string): string {
  if (text.length <= TOOL_OUTPUT_CAP) return text;
  return text.slice(0, TOOL_OUTPUT_CAP) + `\n...[truncated ${text.length} chars]`;
}

/**
 * Single async agent loop: stream → permission check → exec → append → repeat.
 * Never throws, never calls process.exit — returns partial results on cancel.
 * index.ts owns SIGINT/exit; tools and provider are injected/testable seams.
 */
export async function agentLoop(args: LoopArgs): Promise<LoopResult> {
  const runId = newRunId();
  const depth = args.depth ?? 0;
  const isChild = depth > 0;
  // One value decides the ask branch. `--yolo` and `--plan` are shorthands for
  // two of the modes, so the ladder has a single source of truth; plan keeps
  // outranking yolo exactly as it did when they were two booleans.
  const mode: PermissionMode =
    args.permissionMode ?? (args.planMode === true ? "plan" : args.yolo ? "bypassPermissions" : "default");
  // Plan is structural, not a rung: a caller that says planMode (the CLI, and
  // every child run) stays read-only whatever the mode field says.
  const planMode = args.planMode === true || mode === "plan";
  const manual = mode === "manual";
  let agentFileErrors: string[] = [];
  // Child runs get the agent's own body; composition lives in system.ts so the
  // ordering rule (harness policy, then per-run advertising, then the human's
  // appended text) is testable without a provider.
  let roster = "";
  if (!isChild) {
    // Delegation roster rides the system message (dynamic per run — agent
    // files are user-authored), keeping the delegate tool spec static. A
    // broken agent file is surfaced, never swallowed silently (emitted once
    // `emit` exists, right after the transcript seed). Roster is capped:
    // a pile of agent files is a per-turn token cost compaction can't touch.
    const { agents, errors } = listAgentsWithErrors(args.cwd);
    agentFileErrors = errors;
    roster = agents.slice(0, MAX_ROSTER).map((a) => `- ${a.name}: ${a.description}`).join("\n");
  }
  const appendParts = [
    args.appendSystemPrompt ?? "",
    args.structuredSchema === undefined ? "" : structuredInstruction(args.structuredSchema),
  ].filter((p) => p.length > 0);
  const systemContent = composeSystemPrompt({
    ...(args.systemPrompt === undefined ? {} : { base: args.systemPrompt }),
    ...(appendParts.length === 0 ? {} : { append: appendParts.join("\n\n") }),
    planMode,
    isChild,
    roster,
    excludeDynamicSections: args.excludeDynamicSections === true,
  });
  // Host tools belong to the run that declared them. A child is never OFFERED
  // one (`toolSpecs` drops them at depth > 0, because a child's whole
  // authority is read+search and a caller function there would be mutation by
  // proxy), but the map is built either way so a fabricated call in a child
  // names itself in the audit chain — `loop:child-host-tool`, not the generic
  // "unknown tool" a made-up name gets.
  const hosts = new Map<string, HostToolDef>();
  const hostRejections: string[] = [];
  for (const d of args.customTools ?? []) {
    const problem = hostToolProblem(d);
    if (problem !== null) {
      hostRejections.push(problem);
      continue;
    }
    if (hosts.has(d.name)) {
      hostRejections.push(`"${d.name}" is declared twice — only the first definition is offered`);
      continue;
    }
    hosts.set(d.name, d);
  }
  // Filtered once, not per turn: every provider call in a run must advertise
  // exactly the same toolset, or a failover mid-run changes the contract the
  // transcript was written against.
  const specs = toolSpecs(depth, args.disallowedTools, [...hosts.values()]);
  const messages: LoopMsg[] = [
    { role: "system", content: systemContent },
    ...(args.history ?? []),
    { role: "user", content: args.prompt },
  ];
  const calls: OutcomeToolCall[] = [];
  const trace: LoopTraceCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let steps = 0;
  let seq = 0;
  /** Successful edit/write calls snapshotted this run (undo trail). */
  let checkpoints = 0;
  let compactEvents = 0;
  let compactTruncated = 0;
  let compactDropped = 0;
  let cancelled = false;
  let text = "";
  let error: string | undefined;
  // Overwritten by every break below; the loop falling out on its own is the
  // step cap, so that is the initial value.
  let stopReason: StopReason = "max_steps";
  /** `--json-schema`: verdict on the final answer, and repairs spent on it. */
  let structured: LoopResult["structured"];
  let repairsUsed = 0;
  const emit = (kind: LoopEvent["kind"], msg: string): void => {
    try {
      args.onEvent?.({ kind, text: msg });
    } catch {
      // Listener failures never break the loop.
    }
  };
  const dbg = args.debug ?? NOOP_DEBUG;
  for (const e of agentFileErrors) {
    emit("policy", `subagent file skipped: ${e}`);
  }  for (const e of hostRejections) {
    emit("policy", `host tool refused: ${e}`);
  }
  // Hooks load once at run start (the caller owns the LoadedHooks), so a
  // mid-run injection can neither register nor edit one; a broken config is
  // surfaced here, never swallowed.
  const hookDefs = args.hooks?.defs ?? [];
  for (const e of args.hooks?.errors ?? []) {
    emit("hook", `hooks config: ${e}`);
  }
  if (hookDefs.length > 0) {
    emit("hook", `hooks armed: ${hookDefs.length}`);
  }
  dbg(
    `run ${runId} ${args.label}:${args.model} depth=${depth} steps<=${args.maxSteps} mode=${mode}` +
      ` plan=${planMode} yolo=${args.yolo} tokens=${args.tokenBudget ?? "none"} cost=${args.costCheck === undefined ? "none" : "armed"}` +
      ` tools=${specs.length} hooks=${hookDefs.length} roots=${args.roots?.length ?? 0} history=${args.history?.length ?? 0}` +
      ` compact>${args.compactTokens ?? DEFAULT_COMPACT_TOKENS}`
  );
  let hooksFired = 0;
  let hooksDenied = 0;
  let hooksWarned = 0;

  let current = { label: args.label, model: args.model, port: args.port };
  const buckets = new Map<string, UsageBucket>();
  const failoverTrail: FailoverRecord[] = [];
  /** Promoted policy.md denies, loaded once per run (pre-flight block). */
  const promoted = loadPromotedDenies(args.cwd);
  let waitedMs = 0;
  let waitedOnce = false;
  /** Chain hops consumed so far (0 = still on the head provider). */
  let failedOver = 0;
  /** Next unconsumed cross-provider target — each target: at most one hop. */
  let nextTarget = 0;
  /**
   * Same-provider rotation targets, PRE-RESOLVED against the head port and
   * consumed by index (each once per run — no cycles). Resolving here is the
   * fix for the /model × rotation interleaving: candidates used to be bare
   * model ids resolved against whatever port `current` held, so after a live
   * /model switch a 429 sent head-provider ids to the switched-to provider.
   * Now rotation is gated on `current.port === args.port` — structurally
   * impossible off the head port, no flag check to forget.
   */
  const rotationTargets: FailoverTarget[] = (args.models ?? [])
    .filter((m) => m !== args.model)
    .map((m) => ({ label: args.label, model: m, port: args.port }));
  let nextRotation = 0;
  /** Every label:model the run has dialed, for the exhausted-retry message. */
  const tried = new Set<string>([`${args.label}:${args.model}`]);
  /** A live /model switch was applied this turn — for terminal-failure attribution. */
  let switchedThisTurn = false;
  /**
   * Run-scoped memo of idempotent tool results, keyed `tool:argsHash`. Cleared
   * whenever a successful edit/write changes the tree, so a legitimate re-read
   * after a mutation still executes. A weak model can otherwise burn the step
   * budget re-running the same call while every repeat bloats the prompt that
   * all later turns re-send.
   */
  const memo = new Map<string, { output: string; repeats: number }>();
  let repeatCalls = 0;
  let auditDropped = 0;
  const addUsage = (p: number, c: number, estimated: boolean): void => {
    promptTokens += p;
    completionTokens += c;
    const key = `${current.label}:${current.model}`;
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      bucket = { label: current.label, model: current.model, prompt: 0, completion: 0 };
      buckets.set(key, bucket);
    }
    bucket.prompt += p;
    bucket.completion += c;
    // A bucket is only honest as metered when every contributing call was.
    bucket.estimated = bucket.estimated === true || estimated;
  };
  /**
   * Child usage folds into the parent's buckets and run totals: delegation
   * spends the parent's budget honestly (receipts rule), never off-book.
   */
  const foldChildUsage = (childBuckets: UsageBucket[]): void => {
    for (const b of childBuckets) {
      promptTokens += b.prompt;
      completionTokens += b.completion;
      const key = `${b.label}:${b.model}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { label: b.label, model: b.model, prompt: 0, completion: 0 };
        buckets.set(key, bucket);
      }
      bucket.prompt += b.prompt;
      bucket.completion += b.completion;
      if (b.estimated === true) bucket.estimated = true;
    }
  };

  for (let step = 1; step <= args.maxSteps; step++) {
    if (args.signal?.aborted === true) {
      cancelled = true;
      stopReason = "cancelled";
      break;
    }
    switchedThisTurn = false;
    if (args.takePendingSwitch !== undefined) {
      const switched = args.takePendingSwitch();
      if (switched !== null) {
        current = { ...switched };
        switchedThisTurn = true;
      }
    }
    steps = step;
    // Compaction gate (committee ruling 3): when a single provider call's
    // estimated size crosses the ceiling, prune the oldest tail first —
    // honest receipt line, message structure kept valid.
    const compactLimit = args.compactTokens ?? DEFAULT_COMPACT_TOKENS;
    if (compactLimit > 0) {
      const est = estimateTokens(messages);
      if (est > compactLimit) {
        const c = compactTranscript(messages, compactLimit);
        if (c.truncated > 0 || c.dropped > 0) {
          messages.splice(0, messages.length, ...c.messages);
          compactEvents += 1;
          compactTruncated += c.truncated;
          compactDropped += c.dropped;
          emit(
            "compact",
            `compacted: ${c.truncated} old tool output(s) truncated, ${c.dropped} exchange(s) elided (est. ${c.tokensBefore} → ${c.tokensAfter} tokens)`
          );
          dbg(`compaction fired at est=${est} > ${compactLimit}: ${c.tokensBefore} → ${c.tokensAfter} est tokens, ${messages.length} messages kept`);
        } else {
          dbg(`est ${est} > ${compactLimit} but nothing was prunable (system + protected tail only)`);
        }
      }
    }
    dbg(`step ${steps}/${args.maxSteps} on ${current.label}:${current.model} — ${messages.length} messages, est ${estimateTokens(messages)} tokens`);
    // One turn: at most one bounded wait per RUN; each rate-limited/timeout/server
    // retry consumes at most one rotation candidate or one chain target.
    // Retries never consume maxSteps; a failed turn leaves no message behind.
    let turn: Awaited<ReturnType<ChatPort>> | null = null;
    for (;;) {
      let attempt: Awaited<ReturnType<ChatPort>>;
      try {
        attempt = await current.port({
          model: current.model,
          messages,
          tools: specs,
          signal: args.signal,
        });
      } catch (err) {
        error = err instanceof Error ? err.message : "provider failed";
        break;
      }
      if (attempt.ok) {
        turn = attempt;
        break;
      }
      if (attempt.error === "cancelled" || (args.signal !== undefined && args.signal.aborted)) {
        cancelled = true;
        break;
      }
      if (
        attempt.retryable !== "rate-limited" &&
        attempt.retryable !== "timeout" &&
        attempt.retryable !== "server"
      ) {
        // Terminal (auth/other/bad-request): the switch applied at this
        // turn's boundary is the failure's context — say so instead of
        // letting the user's /model silently vanish into an opaque error.
        error = switchedThisTurn
          ? `${attempt.error} — the live /model switch to ${current.label}:${current.model} failed terminally (it was applied at this turn's boundary)`
          : attempt.error;
        dbg(`terminal failure on ${current.label}:${current.model} (retryable=${String(attempt.retryable)}): ${attempt.error}`);
        break;
      }
      // Timeouts and upstream 5xx join the rotation path: a fresh attempt on a
      // different model (or provider) beats waiting — waiting helps 429s, not
      // slow models, stalled connections, or a host that is down. Retry-wait
      // stays 429-only.
      const timedOut = attempt.retryable === "timeout";
      const cause =
        timedOut ? "timed out" : attempt.retryable === "server" ? "server error" : "rate limited";
      dbg(`${cause} on ${current.label}:${current.model} (retryable=${String(attempt.retryable)}, retryAfter=${attempt.retryAfterMs ?? "none"}) — taking the retry path`);
      if (
        !timedOut &&
        args.retryWait === true &&
        !waitedOnce &&
        attempt.retryAfterMs !== undefined &&
        attempt.retryAfterMs > 0
      ) {
        waitedOnce = true;
        const wait = Math.min(attempt.retryAfterMs, 60000);
        dbg(`Retry-After ${attempt.retryAfterMs}ms → sleeping ${wait}ms (one wait per run, then the rotation path)`);
        if (!args.quietFailover) emit("retry", `rate limited on ${current.label} — waiting ${Math.round(wait / 1000)}s (once)`);
        const slept = await sleepMs(wait, args.signal);
        if (!slept) {
          cancelled = true;
          break;
        }
        waitedMs += wait;
        continue;
      }
      // Same-provider model rotation: pre-resolved head-port targets, each
      // once per run, on rate-limit or timeout. Ordered after the single
      // retry-wait and before cross-provider failover (same-provider moves
      // are cheaper than provider switches). Transcript carries over: same
      // provider, same tool specs. Gated on the head PROVIDER label, not a
      // hop counter — after a live /model switch (or any provider hop) the
      // head provider's model ids must not be sent to the new port.
      const rotation = current.label === args.label ? rotationTargets[nextRotation] : undefined;
      if (rotation !== undefined) {
        nextRotation += 1;
        const from = `${current.label}:${current.model}`;
        const to = `${rotation.label}:${rotation.model}`;
        tried.add(to);
        failoverTrail.push({ from, to, reason: attempt.error, waitedMs, step });
        if (!args.quietFailover) emit("failover", `${cause} on ${current.model} — rotating to ${to}`);
        current = { label: rotation.label, model: rotation.model, port: rotation.port };
        continue;
      }
      if (current.label !== args.label) {
        dbg(`rotation not eligible: the active port is ${current.label}, not the head ${args.label} — its model ids do not belong there`);
      } else if (rotationTargets.length > 0) {
        dbg(`rotation exhausted: ${nextRotation}/${rotationTargets.length} same-provider candidates already used this run`);
      }
      // Cross-provider chain: hops in armed order, one target per
      // rate-limited/timeout/server turn, each target at most once per run.
      const target = args.failovers?.[nextTarget];
      if (target !== undefined) {
        nextTarget += 1;
        failedOver += 1;
        const from = `${current.label}:${current.model}`;
        const to = `${target.label}:${target.model}`;
        tried.add(to);
        failoverTrail.push({ from, to, reason: attempt.error, waitedMs, step });
        if (!args.quietFailover) emit("failover", `${cause} on ${current.label} — failing over to ${to}`);
        current = { label: target.label, model: target.model, port: target.port };
        continue;
      }
      dbg(`no hop left: chain has ${args.failovers?.length ?? 0} target(s), ${nextTarget} used; tried ${[...tried].join(", ") || current.model}`);
      const triedList = [...tried].join(", ");
      const switchNote = switchedThisTurn
        ? ` — the live /model switch to ${current.label}:${current.model} failed terminally (it was applied at this turn's boundary)`
        : "";
      error = timedOut && failedOver === 0 && tried.size === 1
        ? `${attempt.error}${switchNote} — retry with --models <a,b> to rotate, --failover to switch provider, or --timeout-ms to allow longer calls`
        : failedOver > 0 || tried.size > 1
          ? `${cause} (tried ${triedList}${failedOver > 0 ? ` then ${current.label}:${current.model}` : ""}; waited ${waitedMs}ms) — retry list exhausted: wait out the quota, add --retry-wait, or widen the chain with --models/--failover — partial transcript kept`
          : `${attempt.error}${switchNote}`;
      stopReason = "error";
      break;
    }
    if (cancelled || error !== undefined || turn === null) {
      stopReason = cancelled ? "cancelled" : "error";
      break;
    }
    addUsage(turn.promptTokens, turn.completionTokens, turn.usageEstimated === true);
    dbg(
      `metered +${turn.promptTokens}p/+${turn.completionTokens}c${turn.usageEstimated === true ? " (estimated)" : ""}` +
        ` = ${promptTokens + completionTokens} tokens${args.tokenBudget === undefined ? "" : ` of ${args.tokenBudget}`}`
    );
    if (args.tokenBudget !== undefined && promptTokens + completionTokens > args.tokenBudget) {
      error = `token budget exhausted (${promptTokens + completionTokens}/${args.tokenBudget}) — partial transcript kept`;
      stopReason = "token_budget";
      emit("policy", `token budget exhausted — stopping (partial transcript kept, receipt follows)`);
      break;
    }
    // Dollar ceiling: pricing is surface knowledge (router.ts), so the surface
    // supplies the predicate and core only asks it after each billed turn.
    if (args.costCheck !== undefined) {
      const stop = args.costCheck([...buckets.values()]);
      if (stop !== null) {
        error = stop.message;
        stopReason = stop.stopReason;
        emit("policy", `${stop.message} — stopping (partial transcript kept, receipt follows)`);
        break;
      }
    }
    messages.push({
      role: "assistant",
      content: turn.text ?? "",
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    });
    if (turn.toolCalls.length === 0) {
      text = turn.text ?? "";
      if (args.structuredSchema !== undefined) {
        // The answer is a gate, not a preference: a run that produced prose
        // where JSON was demanded has not finished, whatever it says. One
        // repair round is spent on it — a real turn, billed and counted in
        // num_turns, so the receipt shows the extra spend.
        const verdict = structuredTurn(text, args.structuredSchema);
        if (verdict.ok) {
          structured = verdict;
        } else if (repairsUsed < MAX_REPAIRS) {
          repairsUsed += 1;
          emit("policy", `structured answer rejected (${verdict.errors.length} problem(s)) — asking for a repair, attempt ${repairsUsed}/${MAX_REPAIRS}`);
          messages.push({ role: "user", content: repairNote(verdict.errors) });
          continue;
        } else {
          structured = verdict;
          error = `answer does not satisfy --json-schema: ${verdict.errors.slice(0, 3).join("; ")}${verdict.errors.length > 3 ? ` (+${verdict.errors.length - 3} more)` : ""}`;
          stopReason = "error";
          emit("policy", `${error} — failing rather than returning an unvalidated document`);
          break;
        }
      }
      stopReason = "complete";
      break;
    }
    for (const call of turn.toolCalls) {
      seq += 1;
      const def = lookupTool(call.name, hosts);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(call.argsJson) as unknown;
      } catch {
        parsed = null;
      }
      const hash = argsHash(parsed ?? call.argsJson);
      let subjectVal = "";
      const record = (decision: string, ruleId: string, resultHash: string, actor: AuditActor, preview: string, shape?: string): void => {
        calls.push({ seq, tool: call.name, args_hash: hash, result_hash: resultHash, decision, ruleId, ...(shape === undefined ? {} : { shape }) });
        // Per-call flush (P0): a crash loses at most one entry, never the trail.
        // A non-null return means the entry was NOT recorded — surfaced loudly
        // here and in the run summary instead of silently shedding history
        // the verifier cannot know existed.
        const auditError = appendEntry(args.cwd, {
          runId,
          actor,
          tool: call.name,
          args_hash: hash,
          result_hash: resultHash,
          policy: `${decision}:${ruleId}`,
        });
        if (auditError !== null) {
          auditDropped += 1;
          emit("policy", `audit: ${auditError}`);
        }
        trace.push({ seq, tool: call.name, policy: `${decision}:${ruleId}`, actor, preview: redactSecrets(preview).slice(0, 500), subject: redactSecrets(subjectVal) });
      };
      if (def === null || parsed === null) {
        const out = def === null ? `unknown tool: ${call.name}` : "bad tool args JSON";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "loop:bad-call", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} (loop:bad-call)`);
        continue;
      }
      const preview = previewForLog(call.name, parsed);
      // The one question every builtin-only rule asks: is this name one of the
      // twelve? Null for a host tool, which is then excluded from the policy
      // row, the shape grammar, the flag grammar, the memo and the checkpoint
      // path — all of which are written against builtins.
      const builtinName: ToolName | null = isToolName(def.name) ? def.name : null;
      // Depth guard (belt): children never see the delegate specs, but a
      // rogue tool call for a non-advertised tool still fails closed here.
      // Children also have no network — webfetch is the parent's to make.
      if (isChild && (def.name === "delegate" || def.name === "delegate_many")) {
        const out = "delegation depth exhausted: subagents cannot delegate";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "loop:max-depth", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} (loop:max-depth)`);
        continue;
      }
      if (isChild && def.name === "webfetch") {
        const out = "subagents have no network access — the parent fetches and passes content";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "loop:child-no-network", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (loop:child-no-network)`);
        continue;
      }
      // todo is parent-run state (the checklist IS the parent's plan); the
      // spec filter hides it from children, this closes the fabricated-call
      // path — lookupTool admits any TOOLS key regardless of depth.
      if (isChild && def.name === "todo") {
        const out = "subagents are read-only — the parent run owns the task list";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "loop:child-readonly", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (loop:child-readonly)`);
        continue;
      }
      // A host tool is a caller function running with the parent's authority.
      // A child has no authority of its own beyond reading, so it never gets
      // one — not even a "read-only" host tool, because the harness cannot
      // tell what that function does.
      if (isChild && builtinName === null) {
        const out = "subagents cannot call host-provided tools — the parent run owns them";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "loop:child-host-tool", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (loop:child-host-tool)`);
        continue;
      }
      // Plan mode is run-scoped policy: mutations and delegation are refused
      // before the permission ladder, so ask/yolo/remembered can never grant
      // them — a read-only plan run spawns no children. A host tool's body is
      // opaque to the harness, so plan mode refuses it on that opacity alone.
      if (
        planMode &&
        (builtinName === null ||
          def.name === "edit" || def.name === "write" || def.name === "bash" ||
          def.name === "delegate" || def.name === "delegate_many")
      ) {
        const out = `plan mode: run is read-only — ${call.name} refused; produce a plan instead`;
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "plan:read-only", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (plan:read-only)`);
        continue;
      }
      const subject = permissionSubject(def.name, parsed, preview);
      subjectVal = subject;
      // `--disallowed-tools` is run-scoped refusal, so it sits with plan mode
      // ABOVE the ladder: no denylist match, remembered rule, human yes or
      // --yolo can grant what the operator filtered out. On a conflict
      // between the two lists the disallow wins, because that is the safe
      // reading of a mistyped flag.
      // A host tool is not addressable by that flag: its filter grammar is
      // path/command/origin, none of which mean anything for an arbitrary
      // caller function. The way to refuse a host tool is not to offer it.
      const banned = builtinName === null ? null : matchToolFilter(args.disallowedTools, builtinName, subject);
      if (banned !== null) {
        const out = `refused for this run (--disallowed-tools ${describeToolFilter(banned)})`;
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "cli:disallowed", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (cli:disallowed)`);
        continue;
      }
      // A subagent's whole authority is read+search, so a run that filtered
      // either out cannot delegate — that would be reading by proxy. Checked
      // here rather than threaded into child runs.
      if (
        (def.name === "delegate" || def.name === "delegate_many") &&
        delegationBlind(args.disallowedTools)
      ) {
        const out = "delegate refused for this run: read and/or search are disallowed, and a subagent's only authority is reading";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "cli:disallowed:delegate", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (cli:disallowed:delegate)`);
        continue;
      }
      const verdict = checkPermission(def.name, subject, promoted, {
        skipPolicyDenies: args.policySurface === "prompt",
      });
      if (verdict.decision === "deny") {
        const out = `denied by ${verdict.ruleId}: ${verdict.reason}`;
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", verdict.ruleId, sha256Hex(out), "policy", redactSecrets(out));
        emit("tool", `deny ${call.name} ${preview} (${verdict.ruleId})`);
        continue;
      }
      let proceed = verdict.decision === "allow";
      let grantActor: AuditActor = "policy";
      let ruleId = verdict.ruleId;
      if (verdict.decision === "ask") {
        // `--allowed-tools` is a human grant typed on the command line, so it
        // is consulted before the mode rungs (whose audit line would be the
        // less accurate story when both are present) and always after the deny
        // verdict above. The self-protected guard still applies: naming a tool
        // here buys no more authority over .codewhip/ than pressing `a` does.
        // Manual mode ignores the flag by design — there the operator's standing
        // instruction is that a human answers every ask. A host tool is outside
        // the flag's grammar in both directions: its ask is answered by the
        // caller's `canUseTool`, a mode, or `--yolo`, never by a shape string.
        const granted = manual || builtinName === null ? null : matchToolFilter(args.allowedTools, builtinName, subject);
        const grantProtected =
          granted !== null &&
          (targetsSelfProtected(subject) ||
            (granted.shape !== null && targetsSelfProtected(granted.shape)));
        // acceptEdits answers the ask for the tools whose entire blast radius is
        // one file: the path must resolve inside a jail root (the same
        // containment the exec enforces) and must not be harness state. Shell
        // and network keep asking, because a yes there is not scoped to a file.
        const editSelfAnswers =
          mode === "acceptEdits" &&
          (def.name === "edit" || def.name === "write") &&
          !targetsSelfProtected(subject) &&
          jailPath(args.cwd, subject, args.roots) !== null;
        if (granted !== null && !grantProtected) {
          proceed = true;
          grantActor = "human";
          ruleId = `${verdict.ruleId}+allowed-tools`;
        } else if (granted !== null) {
          const out = `--allowed-tools grant refused: ${preview} touches a self-protected path`;
          messages.push({ role: "tool", toolCallId: call.id, content: out });
          record("deny", `${verdict.ruleId}+allowed-tools-protected`, sha256Hex(out), "policy", out);
          emit("tool", `deny ${call.name} ${preview} (allowed-tools-protected)`);
          continue;
        } else if (mode === "bypassPermissions") {
          proceed = true;
          grantActor = "yolo";
          // The ruleId names where the grant actually came from, so a
          // transcript can tell --yolo from --permission-mode
          // bypassPermissions even though both are the yolo actor.
          ruleId = args.yolo ? `${verdict.ruleId}+yolo` : `${verdict.ruleId}+mode:bypassPermissions`;
        } else if (editSelfAnswers) {
          proceed = true;
          grantActor = "human";
          ruleId = `${verdict.ruleId}+mode:acceptEdits`;
        } else if (mode === "dontAsk") {
          const out = `refused (--permission-mode dontAsk): ${verdict.ruleId} was not granted by policy or --allowed-tools`;
          messages.push({ role: "tool", toolCallId: call.id, content: out });
          record("deny", `${verdict.ruleId}+mode:dontAsk`, sha256Hex(out), "policy", out);
          emit("tool", `deny ${call.name} ${preview} (mode:dontAsk)`);
          continue;
        } else if (args.askUser === undefined || (!args.stdinIsTTY && args.askUserIsHost !== true)) {
          const out = `held for approval (${verdict.ruleId}) — non-interactive, denied`;
          messages.push({ role: "tool", toolCallId: call.id, content: out });
          record("deny", `${verdict.ruleId}+held`, sha256Hex(out), "policy", out);
          emit("tool", `held ${call.name} ${preview} (${verdict.ruleId})`);
          continue;
        } else {
          // Remembered-shape shortcut: a prior `a` answer stored this
          // shape in .codewhip/remembered.jsonl, with provenance
          // (ts/runId/preview_hash). Policy lives in the harness,
          // never in the prompt — matches here cost 0 tokens.
          const subjectForShape = subject;
          // A host tool is never memorable. Its subject is whatever that
          // function was handed — not a path, command head or origin the shape
          // grammar understands — and `RememberedRule.tool` is a builtin-only
          // union, so storing one would either write a rule no matcher reads
          // or a rule that reads as a different tool. The grant stays per-call.
          const shape = builtinName === null ? null : shapeOf(builtinName, subjectForShape);
          const rules = [...(args.remembered ?? [])];
          // Bash shapes are `${head} *`: match the bare head ("ls") or head
          // + args ("ls -la"). Edit/write shapes are bare paths: exact match
          // only (no prefix over-match into sibling files). Webfetch shapes
          // are bare origins: re-derive the subject's origin (normalizes
          // case/trailing dots) instead of slicing strings, so sibling-host
          // prefix games can't match and odd spellings fail closed to ask.
          const hit =
            manual || shape === null
              ? undefined
              : rules.find((r) => {
                  if (r.tool !== def.name || r.shape !== shape) return false;
                  if (def.name === "bash") return true;
                  if (def.name === "webfetch") return webfetchOrigin(subjectForShape) === r.shape;
                  return subjectForShape === shape;
                });
          // A remembered rule NEVER covers a self-protected subject: a stored
          // `cat *` shape would otherwise auto-allow `cat .codewhip/key` and
          // hand the signature trust root to the model (security panel,
          // 2026-09-13). The shape names the head, the subject names the
          // target — the target is what must pass the guard.
          if (hit !== undefined && targetsSelfProtected(def.name === "webfetch" ? hit.shape : subjectForShape)) {
            const out = `remembered rule refused: ${preview} touches a self-protected path`;
            messages.push({ role: "tool", toolCallId: call.id, content: out });
            record("deny", `${verdict.ruleId}+remembered-protected`, sha256Hex(out), "policy", out);
            emit("tool", `deny ${call.name} ${preview} (remembered-protected)`);
            continue;
          }
          if (hit !== undefined) {
            proceed = true;
            grantActor = "remembered";
            ruleId = `${verdict.ruleId}+remembered`;
          } else {
            let answer: ApprovalAnswer = "no";
            try {
              answer = await args.askUser(
                `allow ${call.name} ${preview}? [y/N/s/a] (s = this session only, a = remember) `,
                { tool: def.name, subject, preview, args: parsed, ruleId: verdict.ruleId, runId, step: steps, seq }
              );
            } catch {
              answer = "no";
            }
            if (answer === "no") {
              const out = `held for approval (${verdict.ruleId}) — declined`;
              messages.push({ role: "tool", toolCallId: call.id, content: out });
              // Declines record a generalizable deny shape (independent of
              // allow-curation, so dangerous heads stay promotable). A host
              // tool has no shape grammar — its decline is still audited, and a
              // team that wants it refused pre-flight writes `deny <tool>:<shape>`
              // in policy.md by hand, which matches on the same strings.
              const dshape = builtinName === null ? null : declineShape(builtinName, subjectForShape);
              record("deny", `${verdict.ruleId}+declined`, sha256Hex(out), "human", out, dshape ?? undefined);
              emit("tool", `held ${call.name} ${preview} (${verdict.ruleId})`);
              continue;
            }
            grantActor = "human";
            // Session scope (UX panel: consent needs a middle rung — one
            // keystroke less than always, zero persistence). The rule lives
            // in this run's in-memory list only; the next run asks again.
            if (answer === "session" && shape !== null && !targetsSelfProtected(shape)) {
              rules.push({ tool: def.name === "webfetch" ? "webfetch" : def.name === "edit" ? "edit" : def.name === "write" ? "write" : "bash", shape, ts: new Date().toISOString(), runId, preview_hash: sha256Hex(preview) });
              ruleId = `${verdict.ruleId}+session`;
            }
            if (answer === "always") {
              if (shape === null) {
                emit("policy", `not memorable: ${subjectForShape.trim().split(/\s/)[0] ?? ""} — approved once, no rule stored`);
              } else if (targetsSelfProtected(shape)) {
                emit("policy", `not memorable: self-protected path — approved once, no rule stored`);
              } else {
                // Edit/write store bare paths, bash stores `head *`, webfetch
                // stores the bare origin — the tool name rides along so the
                // matcher never confuses an origin with a path or a head.
                // Literals (not def.name) so the type stays the stored-rule
                // union; this branch only runs for ask-verdict tools anyway.
                const toolForRule = def.name === "webfetch" ? "webfetch" : def.name === "edit" ? "edit" : def.name === "write" ? "write" : "bash";
                const stored = persistRule(
                  args.cwd,
                  runId,
                  { tool: toolForRule, shape, ts: new Date().toISOString(), runId, preview_hash: sha256Hex(preview) },
                );
                if (stored === "error") {
                  emit("policy", `remember failed (disk write) — approved once for ${shape}`);
                } else {
                  rules.push({ tool: toolForRule, shape, ts: new Date().toISOString(), runId, preview_hash: sha256Hex(preview) });
                  // Grant-time coverage (UX panel): the user must be able to
                  // see what `a` just bought — and revoke it.
                  const scope =
                    toolForRule === "bash"
                      ? `every "${shape.replace(/ \*$/, "")}" command`
                      : toolForRule === "webfetch"
                        ? `every fetch to ${shape}`
                        : `the exact path ${shape}`;
                  const composeRisk = toolForRule === "bash" && shape.startsWith("npm run")
            ? " NOTE: npm run executes package.json scripts — edits to scripts or dependencies become executable without prompting; revoke if that is not what you want."
            : "";
          emit("policy", `remembered: ${toolForRule}:${shape} — covers ${scope}, all future runs.${composeRisk} Revoke: codewhip remember forget ${toolForRule}:${shape}`);
                }
                ruleId = `${verdict.ruleId}+always`;
              }
            }
            proceed = true;
          }
        }
      }
      if (!proceed) {
        continue;
      }
      dbg(`ladder ${def.name} subject="${subject}" verdict=${verdict.decision}:${verdict.ruleId} mode=${mode} → granted by ${grantActor} (${ruleId})`);
      // Repeat guard: an idempotent call already answered unchanged this
      // generation is served from the memo. Permission was still evaluated
      // above, so repeats stay visible on the audit trail, not hidden.
      const memoKey = `${def.name}:${hash}`;
      const guardOn = args.repeatGuard !== false;
      if (guardOn && builtinName !== null && IDEMPOTENT_TOOLS.has(builtinName)) {
        const hit = memo.get(memoKey);
        if (hit !== undefined) {
          hit.repeats += 1;
          repeatCalls += 1;
          // The nudge is appended AFTER the stored output, never instead of
          // it: compaction may already have truncated what the model saw,
          // and a repeat is often the legitimate attempt to recover it.
          const nudge =
            hit.repeats >= REPEAT_NUDGE_AT
              ? `\n\n[repeated ${hit.repeats + 1}x with identical arguments: this result cannot change until the workspace does. Act on it — edit/write — or answer, instead of calling ${call.name} again.]`
              : `\n\n[repeat of ${call.name} with identical arguments — served from this run's memo. Act on this result instead of calling again.]`;
          const served = capOutput(hit.output) + nudge;
          messages.push({ role: "tool", toolCallId: call.id, content: served });
          // Hash the stored (redacted) output, not the note, so the repeat's
          // result_hash matches the original call's byte-for-byte.
          record("allow", "loop:repeat-call", sha256Hex(hit.output.slice(0, 2000)), "policy", served);
          emit("tool", `repeat ${call.name} ${preview} (loop:repeat-call, ${hit.repeats + 1}x)`);
          continue;
        }
      }
      // PreToolUse hooks: AFTER the memo repeat guard (a memo-served repeat
      // must not re-trigger side effects) and before checkpoint+exec. An
      // explicit deny short-circuits the call; a warn verdict proceeds.
      let hookArgs: unknown = parsed;
      if (hookDefs.length > 0) {
        // Hooks sit downstream of the redaction invariant: args ride the
        // stdin payload masked, exactly as the model produced them minus secrets.
        try {
          hookArgs = JSON.parse(redactSecrets(JSON.stringify(parsed))) as unknown;
        } catch {
          hookArgs = redactSecrets(call.argsJson);
        }
        const hr = await runHooksFor(hookDefs, "PreToolUse", def.name, {
          event: "PreToolUse", tool: def.name, seq, runId, cwd: args.cwd, args: hookArgs,
        }, args.hookDeps);
        hooksFired += hr.fired;
        dbg(`PreToolUse(${def.name}): fired=${hr.fired} status=${hr.status}${hr.status === "deny" ? ` reason="${hr.reason}"` : ""}`);
        if (hr.status === "deny") {
          hooksDenied += 1;
          const out = `held by PreToolUse hook: ${hr.reason}`;
          messages.push({ role: "tool", toolCallId: call.id, content: out });
          record("deny", "hook:pretool", sha256Hex(out), "policy", out);
          emit("hook", `deny ${call.name} ${preview} (hook:pretool: ${hr.reason})`);
          continue;
        }
        if (hr.status === "warn") {
          hooksWarned += 1;
          emit("hook", `PreToolUse ${call.name}: ${hr.reason}`);
        }
      }
      // Checkpoint before-image FIRST: undo needs the pre-edit bytes even
      // when the exec itself crashes. Saved only on a successful exec, so
      // failed calls leave no checkpoint trail. Self-protected paths return
      // null and are never snapshotted.
      const beforeImage =
        def.name === "edit" || def.name === "write" ? captureBefore(args.cwd, parsed, args.roots) : null;
      const execStart = Date.now();
      let result: ToolResult;
      try {
        result = await withTimeout(
          (signal) =>
            def.exec(
              {
                cwd: args.cwd,
                roots: args.roots,
                port: current.port,
                model: current.model,
                label: current.label,
                depth,
                onChildUsage: foldChildUsage,
                onChildEvent: (text) => emit("tool", text),
                remainingBudget:
                  args.tokenBudget === undefined ? undefined : Math.max(0, args.tokenBudget - (promptTokens + completionTokens)),
                rotationModels: args.models,
                retryWait: args.retryWait,
                compactTokens: args.compactTokens,
                debug: dbg,
                parentRunId: runId,
                runId,
              },
              parsed,
              signal
            ),
          def.timeoutMs,
          args.signal
        );
      } catch (err) {
        result = { ok: false, output: `tool crashed: ${err instanceof Error ? err.message : "error"}` };
      }
      if (result.ok && beforeImage !== null && saveCheckpoint(args.cwd, runId, seq, beforeImage)) {
        checkpoints += 1;
      }
      // Redact BEFORE anything downstream: the memo stores the same text the
      // model sees (a memo hit bypasses the push below), and the audit hash
      // must cover exactly the stored/served bytes.
      const redacted = redactSecrets(result.output);
      const scrubbed = redacted !== result.output;
      if (result.ok && (def.name === "edit" || def.name === "write" || def.name === "bash")) {
        // The tree may have moved: every memoized read/search is now
        // potentially stale. bash is the common mutation path (npm, git,
        // codegen) — over-invalidation costs one re-read; a stale read
        // corrupts the next edit.
        memo.clear();
      } else if (result.ok && guardOn && builtinName !== null && IDEMPOTENT_TOOLS.has(builtinName)) {
        memo.set(memoKey, { output: redacted, repeats: 0 });
        dbg(`memo: ${memoKey.slice(0, 60)}… stored (${redacted.length} chars)`);
      }
      // Redact BEFORE the cap slice so a secret straddling the boundary is
      // still masked; the note tells the model the data it saw was scrubbed.
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: capOutput(redacted) + (scrubbed ? "\n[redacted: secrets masked before forwarding]" : ""),
      });
      // Immunity telemetry: a human-approved ask is a POSITIVE sample — any
      // candidate deny rule covering this shape would have over-blocked. The
      // shape rides the outcome record (additive, same vocabulary declines
      // use). yolo/remembered/policy grants carry no fresh human bit, so
      // only grantActor "human" records one. A host-tool grant records none:
      // the shape vocabulary is path/command/origin, and a candidate rule built
      // from it could never apply to a caller function.
      record("allow", ruleId, sha256Hex(redacted.slice(0, 2000)), grantActor, redacted,
        grantActor === "human" && builtinName !== null ? declineShape(builtinName, subject) ?? undefined : undefined);
      dbg(`exec ${def.name} ${result.ok ? "ok" : "FAILED"} in ${Date.now() - execStart}ms (timeout ${def.timeoutMs}ms) — ${redacted.length} chars${scrubbed ? ", secrets masked" : ""}, seq ${seq}`);
      emit("tool", `${result.ok ? "ok" : "fail"} ${call.name} ${preview} (${ruleId})`);
      // PostToolUse hooks: observe-only, and they see the REDACTED output —
      // hooks are downstream of the redaction invariant, never upstream of it.
      if (hookDefs.length > 0) {
        const hr = await runHooksFor(hookDefs, "PostToolUse", def.name, {
          event: "PostToolUse", tool: def.name, seq, runId, cwd: args.cwd,
          args: hookArgs, result: redacted.slice(0, 16_000),
        }, args.hookDeps);
        hooksFired += hr.fired;
        if (hr.status !== "pass") {
          // A deny after exec has nothing left to stop — recorded honestly
          // as a warning, never as a phantom veto.
          hooksWarned += 1;
          emit("hook", `PostToolUse ${call.name}: ${hr.reason}`);
        }
      }
    }
  }

  // Stop hooks: observe-only by ruling (block-and-continue is a spend
  // amplifier; maxSteps and the token budget already govern the exit).
  if (hookDefs.length > 0) {
    const hr = await runHooksFor(hookDefs, "Stop", "", {
      event: "Stop", tool: "", seq: 0, runId, cwd: args.cwd,
      text: redactSecrets(text).slice(0, 2000),
      ...(error === undefined ? {} : { error: redactSecrets(error) }),
    }, args.hookDeps);
    hooksFired += hr.fired;
    if (hr.status !== "pass") {
      hooksWarned += 1;
      emit("hook", `Stop: ${hr.reason}`);
    }
  }

  dbg(
    `stop ${stopReason}${error === undefined ? "" : ` ("${error}")`} — steps=${steps} calls=${calls.length} repeats=${repeatCalls}` +
      ` hops=${failoverTrail.length} compact=${compactEvents} checkpoints=${checkpoints} waited=${waitedMs}ms` +
      ` tokens=${promptTokens}+${completionTokens} audit_seq=${seq} dropped=${auditDropped} hooks=${hooksFired}/${hooksDenied}`
  );

  appendOutcome(args.cwd, {
    v: 1,
    ts: new Date().toISOString(),
    runId,
    model: args.model,
    prompt_hash: promptHash(args.prompt),
    yolo: mode === "bypassPermissions",
    permission_mode: mode,
    tool_calls: calls,
    usage: { prompt: promptTokens, completion: completionTokens },
    result_preview_redacted: text.slice(0, 2000),
    verdict: null,
    usageByModel: [...buckets.values()],
    failovers: failoverTrail,
    ...(auditDropped > 0 ? { audit_dropped: auditDropped } : {}),
    ...(hooksFired > 0 ? { hooks: { fired: hooksFired, denied: hooksDenied, warned: hooksWarned } } : {}),
    ...(args.parentRunId === undefined ? {} : { parent_run_id: args.parentRunId }),
    ...(args.taskClass === undefined ? {} : { task_class: args.taskClass }),
  });

  return {
    text,
    runId,
    error,
    stopReason,
    promptTokens,
    completionTokens,
    usageByModel: [...buckets.values()],
    waitedMs,
    failovers: failoverTrail,
    steps,
    toolCalls: calls.length,
    checkpoints,
    compact: { events: compactEvents, truncated: compactTruncated, dropped: compactDropped },
    auditDropped,
    repeatCalls,
    ...(structured === undefined ? {} : { structured }),
    ...(repairsUsed === 0 ? {} : { structuredRepairs: repairsUsed }),
    trace,
    cancelled,
    messages: [...messages],
    contextShape: {
      system: estimateTokens([{ role: "system", content: systemContent }]),
      tools: estimateTokens([{ role: "system", content: JSON.stringify(specs) }]),
      ceiling: args.compactTokens ?? DEFAULT_COMPACT_TOKENS,
    },
  };
}
