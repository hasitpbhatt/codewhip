import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./hash.js";
import { redactSecrets } from "./redact.js";

export type OutcomeToolCall = {
  seq: number;
  tool: string;
  args_hash: string;
  result_hash: string;
  decision: string;
  ruleId: string;
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
    };
    fs.appendFileSync(path.join(dir, "outcomes.jsonl"), JSON.stringify(redacted) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}
