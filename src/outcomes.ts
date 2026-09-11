import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";
import type { ProviderId } from "./provider.js";

export type OutcomeToolCall = {
  seq: number;
  tool: string;
  args_hash: string;
  result_hash: string;
  decision: string;
  ruleId: string;
};

export type FailoverRecord = {
  from: string;
  to: string;
  reason: string;
  waitedMs: number;
  step: number;
};

export type UsageBucket = {
  label: ProviderId;
  model: string;
  prompt: number;
  completion: number;
};

export type OutcomeRecord = {
  v: 1;
  ts: string;
  runId: string;
  model: string;
  prompt_hash: string;
  yolo: boolean;
  tool_calls: OutcomeToolCall[];
  usage: { prompt: number; completion: number };
  result_preview_redacted: string;
  /** Null until Week-4 verdicts (accepted|edited|reverted|rejected). */
  verdict: null;
  /** Optional since v1-freeze: per-provider usage mix (failover runs). */
  usageByModel?: UsageBucket[];
  /** Optional since v1-freeze: retry/failover trail. Old readers ignore it. */
  failovers?: FailoverRecord[];
};

export function newRunId(): string {
  return randomUUID();
}

export function promptHash(prompt: string): string {
  return sha256Hex(prompt);
}

/** Append-only sidecar. Returns false (never throws) when the disk fails. */
export function appendOutcome(cwd: string, record: OutcomeRecord): boolean {
  try {
    const dir = path.join(cwd, ".codewhip");
    fs.mkdirSync(dir, { recursive: true });
    const redacted: OutcomeRecord = {
      ...record,
      result_preview_redacted: redactSecrets(record.result_preview_redacted).slice(0, 2000),
      failovers: record.failovers?.map((f) => ({ ...f, reason: redactSecrets(f.reason) })),
    };
    fs.appendFileSync(path.join(dir, "outcomes.jsonl"), JSON.stringify(redacted) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

/** Tail of the audit chain (lines are already write-redacted). "" when empty/missing. */
export function readLastOutcomes(cwd: string, n: number): string {
  try {
    const file = path.join(cwd, ".codewhip", "outcomes.jsonl");
    const lines = fs.readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    return lines.slice(-Math.max(1, n)).join("\n");
  } catch {
    return "";
  }
}
