import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { sha256Hex } from "./hash.js";
import { redactSecrets, redactEnvValues } from "./redact.js";
import type { ProviderId } from "./provider-port.js";
import type { Verdict } from "./verdict.js";

export type OutcomeToolCall = {
  seq: number;
  tool: string;
  args_hash: string;
  result_hash: string;
  decision: string;
  ruleId: string;
  /** Optional since promotion: curated/memory shape (e.g. "echo *"), set on
   * declines and (since 2026-09-20, immunity telemetry) on human-approved
   * asks — declines are negatives, approvals are positives. */
  shape?: string;
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
  /** Optional since v1-freeze: these counts are chars/4 estimates, not metered. */
  estimated?: boolean;
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
  /** Null until a human records `codewhip verdict` (accepted|edited|reverted|rejected). */
  verdict: null | Verdict;
  /** Optional since v1-freeze: per-provider usage mix (failover runs). */
  usageByModel?: UsageBucket[];
  /** Optional since 2026-09-17: routing class (implement|polish|private) the
   * loop ran under. Absent on older records and non-CLI runs — readers must
   * fall back to model-substring markers, never assume it. */
  task_class?: string;
  /** Optional since 2026-09-24: the permission mode the run's asks terminated
   * on. The `yolo` bit says whether permissions were bypassed, which is now
   * reachable by --permission-mode as well as --yolo; this says which. Absent
   * on older records — readers must treat it as unknown, never default. */
  permission_mode?: string;
  /** Optional since v1-freeze: retry/failover trail. Old readers ignore it. */
  failovers?: FailoverRecord[];
  /** Optional since subagents: set on child runs — spend is already folded
   * into the parent's record, so aggregators must not double-count. */
  parent_run_id?: string;
  /** Optional since 2026-09-18: audit entries this run failed to append
   * (lock contention / disk failure) — nonzero means the signed trail has
   * holes for this runId. Additive; old readers ignore unknown keys. */
  audit_dropped?: number;
  /** Optional since 2026-09-21 (hooks): hook seam tally. fired = hook
   * processes spawned, denied = PreToolUse denials applied, warned =
   * infra failures + ignored post/stop denials. Additive. */
  hooks?: { fired: number; denied: number; warned: number };
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
      result_preview_redacted: redactEnvValues(redactSecrets(record.result_preview_redacted)).slice(0, 2000),
      failovers: record.failovers?.map((f) => ({ ...f, reason: redactEnvValues(redactSecrets(f.reason)) })),
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

/** All outcome records, skipping malformed lines (audit --verify is the integrity tool). */
export function readOutcomeRecords(cwd: string): OutcomeRecord[] {
  try {
    const raw = fs.readFileSync(path.join(cwd, ".codewhip", "outcomes.jsonl"), "utf8");
    const out: OutcomeRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        out.push(JSON.parse(line) as OutcomeRecord);
      } catch {
        // Skip malformed lines.
      }
    }
    return out;
  } catch {
    return [];
  }
}
