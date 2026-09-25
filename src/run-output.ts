import type { Readable } from "node:stream";
import type { LoopEvent, LoopResult, StopReason } from "./loop.js";
import type { UsageBucket } from "./outcomes.js";

/**
 * The headless I/O boundary (parity doc wave 1).
 *
 * The rule is one line: **stdout is data, stderr is prose, stdin is material.**
 * In interactive text mode everything goes to stdout as it always did; under
 * `-p` the human banners, receipts and tool chatter move to stderr so
 * `codewhip run -p "…" | jq` sees exactly one JSON document (or an NDJSON
 * stream plus a final `result` line), and a pipe on stdin is read as context.
 * Nothing here pretends at a fidelity the harness does not have: `stream-json`
 * is event-grained (tool/policy/retry/failover/compact), not token-grained,
 * because `agentLoop()` reports LoopEvents, not deltas.
 */

export type OutputFormat = "text" | "json" | "stream-json";

const FORMATS = new Set<string>(["text", "json", "stream-json"]);

export function parseOutputFormat(raw: string): OutputFormat | null {
  return FORMATS.has(raw) ? (raw as OutputFormat) : null;
}

let mode: OutputFormat | null = null;

/** null = interactive text (banners on stdout, REPL allowed). */
export function setOutputFormat(f: OutputFormat | null): void {
  mode = f;
}

export function outputFormat(): OutputFormat | null {
  return mode;
}

/** True whenever stdout is reserved for data (anything set via -p). */
export function headless(): boolean {
  return mode !== null;
}

type Sink = (stream: "stdout" | "stderr", line: string) => void;

const defaultSink: Sink = (stream, line) => {
  (stream === "stdout" ? process.stdout : process.stderr).write(`${line}\n`);
};

let sink: Sink = defaultSink;

/** Redirect every line this module writes (tests); null restores the real one. */
export function setWriteSink(next: Sink | null): void {
  sink = next ?? defaultSink;
}

/** One human-readable line: stdout when stdout is for humans, stderr otherwise. */
export function say(line: string): void {
  sink(mode === null ? "stdout" : "stderr", line);
}

function ndjson(obj: Record<string, unknown>): void {
  if (mode === "stream-json") sink("stdout", JSON.stringify(obj));
}

/** The opening stream line: what a script needs before any event arrives. */
export function emitInit(obj: Record<string, unknown>): void {
  ndjson({ type: "system", subtype: "init", ...obj });
}

/** One in-run LoopEvent as it happens (stream-json only). */
export function emitEvent(e: LoopEvent): void {
  ndjson({ type: "event", kind: e.kind, text: e.text });
}

/** Hard cap on piped stdin: a runaway `cat` must not become the context. */
export const MAX_STDIN_BYTES = 1_000_000;

/** How long a positional prompt waits for piped context before running without it. */
export const STDIN_CONTEXT_WAIT_MS = 250;

export type StdinRead = { text?: string; error?: string };

/**
 * Read piped stdin to the end, trimmed; `{}` when it carries nothing.
 *
 * `waitMs` makes the read opportunistic: if no byte has arrived inside the
 * window the caller gets nothing back. That distinction exists because the two
 * stdin idioms are not equally urgent — when stdin *is* the prompt there is no
 * run to continue without it, so we wait; when a prompt came from argv and
 * stdin is only extra material, a CI job that hands us a pipe it never writes
 * to must not be able to hang the agent.
 */
export function readStdin(stream: Readable, waitMs?: number): Promise<StdinRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    const onData = (raw: unknown): void => {
      const buf: Buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      total += buf.length;
      if (total > MAX_STDIN_BYTES) {
        finish({ error: `stdin exceeds ${MAX_STDIN_BYTES} bytes — pass the prompt as an argument instead` });
        return;
      }
      chunks.push(buf);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const onEnd = (): void => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      finish(text.length === 0 ? {} : { text });
    };
    const onError = (err: unknown): void => {
      finish({ error: err instanceof Error ? `reading stdin failed: ${err.message}` : "reading stdin failed" });
    };
    const finish = (r: StdinRead): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      stream.removeListener("data", onData).removeListener("end", onEnd).removeListener("error", onError);
      if (waitMs !== undefined) {
        // Abandoning a live pipe: destroy releases the stdin handle, or the
        // pending read keeps the process alive long after the run is over.
        stream.once("error", () => undefined);
        stream.destroy();
      }
      resolve(r);
    };
    stream.on("data", onData).on("end", onEnd).on("error", onError);
    if (waitMs !== undefined) timer = setTimeout(() => finish({}), waitMs);
  });
}

export type RunFacts = {
  provider: string;
  model: string;
  taskClass: string;
  durationMs: number;
  receipt: string;
  costUsd: number | null;
  costNote: string;
  tokenBudget?: number;
  maxBudgetUsd?: number;
  sessionId?: string;
  share?: { path: string; sha256: string };
  polishGate?: { pass: boolean; reason: string };
};

const SUBTYPE: Record<StopReason, string> = {
  complete: "success",
  max_steps: "error_max_steps",
  token_budget: "error_token_budget",
  cost_budget: "error_cost_budget",
  error: "error",
  cancelled: "cancelled",
  hook: "error_hook_stop",
};

/** The single machine document both json and stream-json finish with. */
export function buildResult(result: LoopResult, f: RunFacts): Record<string, unknown> {
  const buckets: UsageBucket[] = result.usageByModel;
  return {
    type: "result",
    subtype: SUBTYPE[result.stopReason],
    is_error: result.error !== undefined || result.cancelled || result.stopReason !== "complete",
    run_id: result.runId,
    ...(f.sessionId === undefined ? {} : { session_id: f.sessionId }),
    provider: f.provider,
    model: f.model,
    task_class: f.taskClass,
    result: result.text,
    ...(result.error === undefined ? {} : { error: result.error }),
    duration_ms: f.durationMs,
    num_turns: result.steps,
    tool_calls: result.toolCalls,
    usage: {
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
      by_model: buckets.map((b) => ({
        label: b.label,
        model: b.model,
        prompt: b.prompt,
        completion: b.completion,
        ...(b.estimated === true ? { estimated: true } : {}),
      })),
    },
    total_cost_usd: f.costUsd,
    cost: f.costNote,
    receipt: f.receipt,
    budget: {
      token_budget: f.tokenBudget ?? null,
      max_budget_usd: f.maxBudgetUsd ?? null,
    },
    checkpointed_files: result.checkpoints,
    compacted: result.compact,
    repeat_calls: result.repeatCalls,
    failovers: result.failovers,
    waited_ms: result.waitedMs,
    audit_entries_dropped: result.auditDropped ?? 0,
    ...(f.polishGate === undefined ? {} : { polish_gate: f.polishGate }),
    ...(f.share === undefined ? {} : { share: f.share }),
    // `--json-schema`: the validated document sits beside the prose, never in
    // place of it — the raw answer is still evidence of what the model said.
    ...(result.structured === undefined
      ? {}
      : {
          structured_output: result.structured.ok ? result.structured.value : null,
          ...(result.structured.ok ? {} : { structured_errors: result.structured.errors }),
        }),
    ...(result.structuredRepairs === undefined ? {} : { structured_repairs: result.structuredRepairs }),
    trace: result.trace,
  };
}

/** Close stdout: one JSON document, or the final stream `result` line. */
export function emitResult(payload: Record<string, unknown>): void {
  if (mode === "json") sink("stdout", JSON.stringify(payload, null, 2));
  else if (mode === "stream-json") ndjson(payload);
}

/** `-p --output-format text`: the result body is the only stdout payload. */
export function writeResultText(text: string): void {
  sink("stdout", text);
}

/**
 * The machine document for a run refused **before** the loop started (no key,
 * route refused, model disabled). There is no LoopResult to report, so this
 * carries the same envelope with zeros — the precise human-readable cause goes
 * to stderr, as every failure already does.
 */
export function buildFailure(f: { provider: string; model: string; receipt: string; reason: string }): Record<string, unknown> {
  return {
    type: "result",
    subtype: "error",
    is_error: true,
    run_id: null,
    provider: f.provider,
    model: f.model,
    result: "",
    error: f.reason,
    num_turns: 0,
    tool_calls: 0,
    usage: { prompt_tokens: 0, completion_tokens: 0, by_model: [] },
    receipt: f.receipt,
    trace: [],
  };
}
