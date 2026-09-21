import type { ChatPort, LoopMsg } from "./provider-port.js";
import { TOOLS, toolSpecs, type ToolDef } from "./tools/registry.js";
import type { ToolName, ToolResult } from "./tools/types.js";
import { checkPermission, permissionSubject } from "./policy.js";
import { loadPromotedDenies } from "./policy-store.js";
import { argsHash, sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";
import { appendOutcome, newRunId, promptHash, type FailoverRecord, type OutcomeToolCall, type UsageBucket } from "./outcomes.js";
import { appendEntry, type AuditActor } from "./audit.js";
import { SYSTEM_PROMPT } from "./system.js";
import { shapeOf, declineShape, targetsSelfProtected } from "./remember.js";
import { webfetchOrigin } from "./tools/webfetch.js";
import { persistRule, type RememberedRule } from "./remember-store.js";
import { captureBefore, saveCheckpoint } from "./checkpoints.js";
import { compactTranscript, estimateTokens, DEFAULT_COMPACT_TOKENS } from "./compact.js";
import { listAgentsWithErrors } from "./subagents.js";
import type { ProviderId } from "./provider-port.js";

export type ApprovalAnswer = "yes" | "session" | "always" | "no";
export type AskUser = (question: string) => Promise<ApprovalAnswer>;

export type LoopEvent = {
  kind: "tool" | "retry" | "failover" | "policy" | "compact";
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

export type LoopResult = {
  text: string;
  runId: string;
  error?: string;
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
  /** Audit entries this run failed to record (lock contention / disk) — nonzero means history has holes. */
  auditDropped?: number;
  /**
   * Final transcript (post-compaction) on every exit path — success, error,
   * cancel. `--continue` persists `messages.slice(1)` (system rebuilt fresh
   * on resume); the saved copy is exactly what the last provider call saw.
   */
  messages: LoopMsg[];
};

function lookupTool(name: string): ToolDef | null {
  if (
    name === "read" || name === "search" || name === "edit" || name === "write" ||
    name === "bash" || name === "webfetch" || name === "delegate" || name === "delegate_many" ||
    name === "run_in_background" || name === "task_output" || name === "task_stop" || name === "todo"
  ) {
    return TOOLS[name];
  }
  return null;
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
  let agentFileErrors: string[] = [];
  // Child runs get the agent's own body; plan mode appends the read-only
  // note with wording that matches the audience (a child reports findings,
  // a top-level --plan run's output IS the plan).
  const baseSystem = args.systemPrompt ?? SYSTEM_PROMPT;
  let systemContent =
    args.planMode === true
      ? isChild
        ? `${baseSystem}\n\nREAD-ONLY SUBAGENT RUN: edit/write/bash/delegate/webfetch are refused by the harness (no mutations, no network). Investigate the workspace freely, then answer with your findings.`
        : `${baseSystem}\n\nPLAN MODE: this run is read-only — edit/write/bash are refused by the harness. Investigate freely, then make your final answer the implementation plan.`
      : baseSystem;
  if (!isChild) {
    // Delegation roster rides the system message (dynamic per run — agent
    // files are user-authored), keeping the delegate tool spec static. A
    // broken agent file is surfaced, never swallowed silently (emitted once
    // `emit` exists, right after the transcript seed). Roster is capped:
    // a pile of agent files is a per-turn token cost compaction can't touch.
    const { agents, errors } = listAgentsWithErrors(args.cwd);
    agentFileErrors = errors;
    const roster = agents.slice(0, MAX_ROSTER).map((a) => `- ${a.name}: ${a.description}`).join("\n");
    if (roster.length > 0) {
      systemContent += `\n\nDelegable subagents (delegate / delegate_many tools):\n${roster}`;
    }
  }
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
  const emit = (kind: LoopEvent["kind"], msg: string): void => {
    try {
      args.onEvent?.({ kind, text: msg });
    } catch {
      // Listener failures never break the loop.
    }
  };
  for (const e of agentFileErrors) {
    emit("policy", `subagent file skipped: ${e}`);
  }

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
        }
      }
    }
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
          tools: toolSpecs(depth),
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
        break;
      }
      // Timeouts and upstream 5xx join the rotation path: a fresh attempt on a
      // different model (or provider) beats waiting — waiting helps 429s, not
      // slow models, stalled connections, or a host that is down. Retry-wait
      // stays 429-only.
      const timedOut = attempt.retryable === "timeout";
      const cause =
        timedOut ? "timed out" : attempt.retryable === "server" ? "server error" : "rate limited";
      if (
        !timedOut &&
        args.retryWait === true &&
        !waitedOnce &&
        attempt.retryAfterMs !== undefined &&
        attempt.retryAfterMs > 0
      ) {
        waitedOnce = true;
        const wait = Math.min(attempt.retryAfterMs, 60000);
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
      const triedList = [...tried].join(", ");
      const switchNote = switchedThisTurn
        ? ` — the live /model switch to ${current.label}:${current.model} failed terminally (it was applied at this turn's boundary)`
        : "";
      error = timedOut && failedOver === 0 && tried.size === 1
        ? `${attempt.error}${switchNote} — retry with --models <a,b> to rotate, --failover to switch provider, or --timeout-ms to allow longer calls`
        : failedOver > 0 || tried.size > 1
          ? `${cause} (tried ${triedList}${failedOver > 0 ? ` then ${current.label}:${current.model}` : ""}; waited ${waitedMs}ms) — retry list exhausted: wait out the quota, add --retry-wait, or widen the chain with --models/--failover — partial transcript kept`
          : `${attempt.error}${switchNote}`;
      break;
    }
    if (cancelled || error !== undefined || turn === null) {
      break;
    }
    addUsage(turn.promptTokens, turn.completionTokens, turn.usageEstimated === true);
    if (args.tokenBudget !== undefined && promptTokens + completionTokens > args.tokenBudget) {
      error = `token budget exhausted (${promptTokens + completionTokens}/${args.tokenBudget}) — partial transcript kept`;
      emit("policy", `token budget exhausted — stopping (partial transcript kept, receipt follows)`);
      break;
    }
    messages.push({
      role: "assistant",
      content: turn.text ?? "",
      toolCalls: turn.toolCalls.length > 0 ? turn.toolCalls : undefined,
    });
    if (turn.toolCalls.length === 0) {
      text = turn.text ?? "";
      break;
    }
    for (const call of turn.toolCalls) {
      seq += 1;
      const def = lookupTool(call.name);
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
      // Plan mode is run-scoped policy: mutations and delegation are refused
      // before the permission ladder, so ask/yolo/remembered can never grant
      // them — a read-only plan run spawns no children.
      if (
        args.planMode === true &&
        (def.name === "edit" || def.name === "write" || def.name === "bash" || def.name === "delegate" || def.name === "delegate_many")
      ) {
        const out = `plan mode: run is read-only — ${call.name} refused; produce a plan instead`;
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "plan:read-only", sha256Hex(out), "policy", out);
        emit("tool", `deny ${call.name} ${preview} (plan:read-only)`);
        continue;
      }
      const subject = permissionSubject(def.name, parsed, preview);
      subjectVal = subject;
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
        if (args.yolo) {
          proceed = true;
          grantActor = "yolo";
          ruleId = `${verdict.ruleId}+yolo`;
        } else if (!args.stdinIsTTY || args.askUser === undefined) {
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
          const shape = shapeOf(def.name, subjectForShape);
          const rules = [...(args.remembered ?? [])];
          // Bash shapes are `${head} *`: match the bare head ("ls") or head
          // + args ("ls -la"). Edit/write shapes are bare paths: exact match
          // only (no prefix over-match into sibling files). Webfetch shapes
          // are bare origins: re-derive the subject's origin (normalizes
          // case/trailing dots) instead of slicing strings, so sibling-host
          // prefix games can't match and odd spellings fail closed to ask.
          const hit =
            shape === null
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
              answer = await args.askUser(`allow ${call.name} ${preview}? [y/N/s/a] (s = this session only, a = remember) `);
            } catch {
              answer = "no";
            }
            if (answer === "no") {
              const out = `held for approval (${verdict.ruleId}) — declined`;
              messages.push({ role: "tool", toolCallId: call.id, content: out });
              // Declines record a generalizable deny shape (independent of
              // allow-curation, so dangerous heads stay promotable).
              const dshape = declineShape(def.name, subjectForShape);
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
      // Repeat guard: an idempotent call already answered unchanged this
      // generation is served from the memo. Permission was still evaluated
      // above, so repeats stay visible on the audit trail, not hidden.
      const memoKey = `${def.name}:${hash}`;
      const guardOn = args.repeatGuard !== false;
      if (guardOn && IDEMPOTENT_TOOLS.has(def.name)) {
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
      // Checkpoint before-image FIRST: undo needs the pre-edit bytes even
      // when the exec itself crashes. Saved only on a successful exec, so
      // failed calls leave no checkpoint trail. Self-protected paths return
      // null and are never snapshotted.
      const beforeImage =
        def.name === "edit" || def.name === "write" ? captureBefore(args.cwd, parsed) : null;
      let result: ToolResult;
      try {
        result = await withTimeout(
          (signal) =>
            def.exec(
              {
                cwd: args.cwd,
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
      } else if (result.ok && guardOn && IDEMPOTENT_TOOLS.has(def.name)) {
        memo.set(memoKey, { output: redacted, repeats: 0 });
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
      // only grantActor "human" records one.
      record("allow", ruleId, sha256Hex(redacted.slice(0, 2000)), grantActor, redacted,
        grantActor === "human" ? declineShape(def.name, subject) ?? undefined : undefined);
      emit("tool", `${result.ok ? "ok" : "fail"} ${call.name} ${preview} (${ruleId})`);
    }
  }

  appendOutcome(args.cwd, {
    v: 1,
    ts: new Date().toISOString(),
    runId,
    model: args.model,
    prompt_hash: promptHash(args.prompt),
    yolo: args.yolo,
    tool_calls: calls,
    usage: { prompt: promptTokens, completion: completionTokens },
    result_preview_redacted: text.slice(0, 2000),
    verdict: null,
    usageByModel: [...buckets.values()],
    failovers: failoverTrail,
    ...(auditDropped > 0 ? { audit_dropped: auditDropped } : {}),
    ...(args.parentRunId === undefined ? {} : { parent_run_id: args.parentRunId }),
    ...(args.taskClass === undefined ? {} : { task_class: args.taskClass }),
  });

  return {
    text,
    runId,
    error,
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
    trace,
    cancelled,
    messages: [...messages],
  };
}
