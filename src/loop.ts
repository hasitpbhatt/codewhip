import type { ChatPort, LoopMsg } from "./provider-port.js";
import { TOOLS, toolSpecs, type ToolDef } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { checkPermission, permissionSubject } from "./policy.js";
import { argsHash, sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";
import { appendOutcome, newRunId, promptHash, type FailoverRecord, type OutcomeToolCall, type UsageBucket } from "./outcomes.js";
import { SYSTEM_PROMPT } from "./system.js";
import { shapeOf, targetsSelfProtected } from "./remember.js";
import { persistRule, type RememberedRule } from "./remember-store.js";
import type { ProviderId } from "./provider.js";

export type ApprovalAnswer = "yes" | "always" | "no";
export type AskUser = (question: string) => Promise<ApprovalAnswer>;

export type LoopEvent = {
  kind: "tool" | "retry" | "failover" | "policy";
  text: string;
};

export type FailoverTarget = {
  label: ProviderId;
  model: string;
  port: ChatPort;
};

export type LoopArgs = {
  prompt: string;
  model: string;
  /** Primary provider label for receipts (e.g. "nvidia"). */
  label: ProviderId;
  cwd: string;
  maxSteps: number;
  yolo: boolean;
  stdinIsTTY: boolean;
  port: ChatPort;
  signal?: AbortSignal;
  askUser?: AskUser;
  /** One bounded Retry-After wait per run (off unless explicitly armed). */
  retryWait?: boolean;
  /** One cross-provider switch per run on 429 only (off unless armed). */
  failover?: FailoverTarget;
  /**
   * Ordered same-provider model candidates, head first (head === model).
   * Empty by default (no rotation). Each candidate is tried at most once
   * per run, on rate-limited turns only — never on auth/other failures.
   */
  models?: string[];
  /** Hard token ceiling for the whole run (prompt+completion). Off when undefined. */
  tokenBudget?: number;
  /** Bootstrap list of remembered rules (index.ts loads once; loop appends on `a`). */
  remembered?: RememberedRule[];
  /** Progress listener (index.ts prints). Never throws into the loop. */
  onEvent?: (event: LoopEvent) => void;
};

export type LoopResult = {
  text: string;
  error?: string;
  promptTokens: number;
  completionTokens: number;
  usageByModel: UsageBucket[];
  waitedMs: number;
  failovers: FailoverRecord[];
  steps: number;
  toolCalls: number;
  cancelled: boolean;
};

function lookupTool(name: string): ToolDef | null {
  if (name === "read" || name === "search" || name === "edit" || name === "write" || name === "bash") {
    return TOOLS[name];
  }
  return null;
}

function previewForLog(name: string, args: unknown): string {
  if (typeof args !== "object" || args === null) {
    return String(args).slice(0, 200);
  }
  const r = args as Record<string, unknown>;
  const v = r["command"] ?? r["path"] ?? r["query"] ?? args;
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
  const messages: LoopMsg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: args.prompt },
  ];
  const calls: OutcomeToolCall[] = [];
  let promptTokens = 0;
  let completionTokens = 0;
  let steps = 0;
  let seq = 0;
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

  let current = { label: args.label, model: args.model, port: args.port };
  const buckets = new Map<string, UsageBucket>();
  const failoverTrail: FailoverRecord[] = [];
  let waitedMs = 0;
  let waitedOnce = false;
  let failedOver = false;
  /** Same-provider models already attempted (head first). Bounds rotation: no cycles. */
  const tried = new Set<string>([args.model]);
  const addUsage = (p: number, c: number): void => {
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
  };

  for (let step = 1; step <= args.maxSteps; step++) {
    if (args.signal?.aborted === true) {
      cancelled = true;
      break;
    }
    steps = step;
    // One turn: at most one bounded wait and one failover per RUN.
    // Retries never consume maxSteps; a failed turn leaves no message behind.
    let turn: Awaited<ReturnType<ChatPort>> | null = null;
    for (;;) {
      let attempt: Awaited<ReturnType<ChatPort>>;
      try {
        attempt = await current.port({
          model: current.model,
          messages,
          tools: toolSpecs(),
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
      if (attempt.retryable !== "rate-limited") {
        error = attempt.error;
        break;
      }
      if (
        args.retryWait === true &&
        !waitedOnce &&
        !failedOver &&
        attempt.retryAfterMs !== undefined &&
        attempt.retryAfterMs > 0
      ) {
        waitedOnce = true;
        const wait = Math.min(attempt.retryAfterMs, 60000);
        emit("retry", `rate limited on ${current.label} — waiting ${Math.round(wait / 1000)}s (once)`);
        const slept = await sleepMs(wait, args.signal);
        if (!slept) {
          cancelled = true;
          break;
        }
        waitedMs += wait;
        continue;
      }
      // Same-provider model rotation: each candidate once per run, 429-only.
      // Ordered after the single retry-wait and before cross-provider
      // failover (same-provider moves are cheaper than provider switches).
      // Transcript carries over: same provider, same tool specs.
      const next = (args.models ?? []).find((m) => !tried.has(m));
      if (next !== undefined) {
        tried.add(next);
        const from = `${current.label}:${current.model}`;
        const to = `${current.label}:${next}`;
        failoverTrail.push({ from, to, reason: attempt.error, waitedMs, step });
        emit("failover", `rate limited on ${current.model} — rotating to ${next}`);
        current = { ...current, model: next };
        continue;
      }
      if (args.failover !== undefined && !failedOver) {
        failedOver = true;
        const from = `${current.label}:${current.model}`;
        const to = `${args.failover.label}:${args.failover.model}`;
        failoverTrail.push({ from, to, reason: attempt.error, waitedMs, step });
        emit("failover", `rate limited on ${current.label} — failing over to ${to}`);
        current = { label: args.failover.label, model: args.failover.model, port: args.failover.port };
        continue;
      }
      const triedList = [...tried].map((m) => `${args.label}:${m}`).join(", ");
      error = failedOver || tried.size > 1
        ? `rate limited (tried ${triedList}${failedOver ? ` then ${current.label}:${current.model}` : ""}; waited ${waitedMs}ms) — partial transcript kept`
        : attempt.error;
      break;
    }
    if (cancelled || error !== undefined || turn === null) {
      break;
    }
    addUsage(turn.promptTokens, turn.completionTokens);
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
      const record = (decision: string, ruleId: string, resultHash: string): void => {
        calls.push({ seq, tool: call.name, args_hash: hash, result_hash: resultHash, decision, ruleId });
      };
      if (def === null || parsed === null) {
        const out = def === null ? `unknown tool: ${call.name}` : "bad tool args JSON";
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", "loop:bad-call", sha256Hex(out));
        emit("tool", `deny ${call.name} (loop:bad-call)`);
        continue;
      }
      const preview = previewForLog(call.name, parsed);
      const subject = permissionSubject(def.name, parsed, preview);
      const verdict = checkPermission(def.name, subject);
      if (verdict.decision === "deny") {
        const out = `denied by ${verdict.ruleId}: ${verdict.reason}`;
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", verdict.ruleId, sha256Hex(out));
        emit("tool", `deny ${call.name} ${preview} (${verdict.ruleId})`);
        continue;
      }
      let proceed = verdict.decision === "allow";
      let ruleId = verdict.ruleId;
      if (verdict.decision === "ask") {
        if (args.yolo) {
          proceed = true;
          ruleId = `${verdict.ruleId}+yolo`;
        } else if (!args.stdinIsTTY || args.askUser === undefined) {
          const out = `held for approval (${verdict.ruleId}) — non-interactive, denied`;
          messages.push({ role: "tool", toolCallId: call.id, content: out });
          record("deny", `${verdict.ruleId}+held`, sha256Hex(out));
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
          const prefix = shape === null ? null : shape.replace(/\*$/, "");
          // Match the remembered head: bare head ("ls") or head + args
          // ("ls -la"). Stored shapes are always `${head} *`, so the head
          // is the prefix minus its trailing space.
          const hit =
            prefix !== null
              ? rules.find(
                  (r) =>
                    r.tool === def.name &&
                    (subjectForShape === prefix.trim() || subjectForShape.startsWith(prefix))
                )
              : undefined;
          if (hit !== undefined) {
            proceed = true;
            ruleId = `${verdict.ruleId}+remembered`;
          } else {
            let answer: ApprovalAnswer = "no";
            try {
              answer = await args.askUser(`allow ${call.name} ${preview}? [y/N/a] `);
            } catch {
              answer = "no";
            }
            if (answer === "no") {
              const out = `held for approval (${verdict.ruleId}) — declined`;
              messages.push({ role: "tool", toolCallId: call.id, content: out });
              record("deny", `${verdict.ruleId}+declined`, sha256Hex(out));
              emit("tool", `held ${call.name} ${preview} (${verdict.ruleId})`);
              continue;
            }
            if (answer === "always") {
              if (shape === null || prefix === null) {
                emit("policy", `not memorable: ${subjectForShape.trim().split(/\s/)[0] ?? ""} — approved once, no rule stored`);
              } else if (targetsSelfProtected(shape)) {
                emit("policy", `not memorable: self-protected path — approved once, no rule stored`);
              } else {
                const toolForRule = def.name === "edit" ? "edit" : def.name === "write" ? "write" : "bash";
                const stored = persistRule(
                  args.cwd,
                  runId,
                  { tool: toolForRule, shape, ts: new Date().toISOString(), runId, preview_hash: sha256Hex(preview) },
                );
                if (stored === "error") {
                  emit("policy", `remember failed (disk write) — approved once for ${shape}`);
                } else {
                  rules.push({ tool: toolForRule, shape, ts: new Date().toISOString(), runId, preview_hash: sha256Hex(preview) });
                  emit("policy", `remembered: ${def.name}:${shape} (.codewhip/remembered.jsonl)`);
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
      let result: ToolResult;
      try {
        result = await withTimeout(
          (signal) => def.exec({ cwd: args.cwd }, parsed, signal),
          def.timeoutMs,
          args.signal
        );
      } catch (err) {
        result = { ok: false, output: `tool crashed: ${err instanceof Error ? err.message : "error"}` };
      }
      const redacted = redactSecrets(result.output);
      const scrubbed = redacted !== result.output;
      // Redact BEFORE the cap slice so a secret straddling the boundary is
      // still masked; the note tells the model the data it saw was scrubbed.
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: capOutput(redacted) + (scrubbed ? "\n[redacted: secrets masked before forwarding]" : ""),
      });
      record("allow", ruleId, sha256Hex(redacted.slice(0, 2000)));
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
  });

  return {
    text,
    error,
    promptTokens,
    completionTokens,
    usageByModel: [...buckets.values()],
    waitedMs,
    failovers: failoverTrail,
    steps,
    toolCalls: calls.length,
    cancelled,
  };
}
