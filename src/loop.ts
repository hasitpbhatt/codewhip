import type { ChatPort, LoopMsg } from "./provider-port.js";
import { TOOLS, toolSpecs, type ToolDef } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { checkPermission } from "./policy.js";
import { argsHash, sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";
import { appendOutcome, newRunId, promptHash, type FailoverRecord, type OutcomeToolCall, type UsageBucket } from "./outcomes.js";
import { SYSTEM_PROMPT } from "./system.js";

export type AskUser = (question: string) => Promise<boolean>;

export type LoopEvent = {
  kind: "tool" | "retry" | "failover";
  text: string;
};

export type FailoverTarget = {
  label: string;
  model: string;
  port: ChatPort;
};

export type LoopArgs = {
  prompt: string;
  model: string;
  /** Primary provider label for receipts (e.g. "nvidia"). */
  label: string;
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
  if (name === "read" || name === "search" || name === "edit" || name === "bash") {
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

function withTimeout(p: Promise<ToolResult>, ms: number): Promise<ToolResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onTimeout = new Promise<ToolResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, output: `tool: timed out after ${ms}ms` }), ms);
  });
  return Promise.race([
    p.finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }),
    onTimeout,
  ]);
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
      if (args.failover !== undefined && !failedOver) {
        failedOver = true;
        const from = `${current.label}:${current.model}`;
        const to = `${args.failover.label}:${args.failover.model}`;
        failoverTrail.push({ from, to, reason: attempt.error, waitedMs, step });
        emit("failover", `rate limited on ${current.label} — failing over to ${to}`);
        current = { label: args.failover.label, model: args.failover.model, port: args.failover.port };
        continue;
      }
      error = failedOver
        ? `rate limited on ${args.label} and ${current.label} (waited ${waitedMs}ms) — partial transcript kept`
        : attempt.error;
      break;
    }
    if (cancelled || error !== undefined || turn === null) {
      break;
    }
    addUsage(turn.promptTokens, turn.completionTokens);
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
      const verdict = checkPermission(def.name, preview);
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
          let approved = false;
          try {
            approved = await args.askUser(`allow ${call.name} ${preview}? [y/N] `);
          } catch {
            approved = false;
          }
          if (!approved) {
            const out = `held for approval (${verdict.ruleId}) — declined`;
            messages.push({ role: "tool", toolCallId: call.id, content: out });
            record("deny", `${verdict.ruleId}+declined`, sha256Hex(out));
            emit("tool", `held ${call.name} ${preview} (${verdict.ruleId})`);
            continue;
          }
          proceed = true;
        }
      }
      if (!proceed) {
        continue;
      }
      let result: ToolResult;
      try {
        result = await withTimeout(
          def.exec({ cwd: args.cwd }, parsed, args.signal),
          def.timeoutMs
        );
      } catch (err) {
        result = { ok: false, output: `tool crashed: ${err instanceof Error ? err.message : "error"}` };
      }
      messages.push({ role: "tool", toolCallId: call.id, content: result.output });
      record("allow", ruleId, sha256Hex(redactSecrets(result.output).slice(0, 2000)));
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
