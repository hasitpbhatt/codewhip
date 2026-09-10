import type { ChatPort, LoopMsg } from "./provider-port.js";
import { TOOLS, toolSpecs, type ToolDef } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import { checkPermission } from "./policy.js";
import { argsHash, sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";
import { appendOutcome, newRunId, promptHash, type OutcomeToolCall } from "./outcomes.js";
import { SYSTEM_PROMPT } from "./system.js";

export type AskUser = (question: string) => Promise<boolean>;

export type LoopArgs = {
  prompt: string;
  model: string;
  cwd: string;
  maxSteps: number;
  yolo: boolean;
  stdinIsTTY: boolean;
  port: ChatPort;
  signal?: AbortSignal;
  askUser?: AskUser;
};

export type LoopResult = {
  text: string;
  error?: string;
  promptTokens: number;
  completionTokens: number;
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

  for (let step = 1; step <= args.maxSteps; step++) {
    if (args.signal?.aborted === true) {
      cancelled = true;
      break;
    }
    steps = step;
    let turn: Awaited<ReturnType<ChatPort>>;
    try {
      turn = await args.port({
        model: args.model,
        messages,
        tools: toolSpecs(),
        signal: args.signal,
      });
    } catch (err) {
      error = err instanceof Error ? err.message : "provider failed";
      break;
    }
    if (!turn.ok) {
      if (turn.error === "cancelled") {
        cancelled = true;
      } else {
        error = turn.error;
      }
      break;
    }
    promptTokens += turn.promptTokens;
    completionTokens += turn.completionTokens;
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
        continue;
      }
      const preview = previewForLog(call.name, parsed);
      const verdict = checkPermission(def.name, preview);
      if (verdict.decision === "deny") {
        const out = `denied by ${verdict.ruleId}: ${verdict.reason}`;
        messages.push({ role: "tool", toolCallId: call.id, content: out });
        record("deny", verdict.ruleId, sha256Hex(out));
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
  });

  return {
    text,
    error,
    promptTokens,
    completionTokens,
    steps,
    toolCalls: calls.length,
    cancelled,
  };
}
