import { spawn } from "node:child_process";
import type { LoopResult, StopReason } from "./loop.js";
import type { LoopMsg } from "./provider-port.js";

export type GoalTurnReceipt = {
  turn: number;
  runId: string;
  stopReason: StopReason;
  promptTokens: number;
  completionTokens: number;
  /** Running total across turns; null when any leg is unpriced (never a 0-fiction). */
  totalCostUsd: number | null;
  /** Alias kept for the pre-review shape; same running total. */
  costUsd: number | null;
};

export type GoalStopReason = "verify_passed" | "complete" | "max_turns" | "error" | "cancelled" | "budget_met";

export type GoalResult = {
  turns: number;
  receipts: GoalTurnReceipt[];
  finalResult: LoopResult;
  stopReason: GoalStopReason;
};

export type GoalOpts = {
  goal: string;
  prompt: string;
  maxTurns: number;
  verifyCmd?: string;
  /** Arm human steering between turns; requires readInterject (throws without it). */
  interject?: true;
  cwd: string;
  agentLoop: (prompt: string, history: LoopMsg[], tokenBudget: number) => Promise<LoopResult>;
  readInterject?: () => Promise<string | undefined>;
  onTurn?: (receipt: GoalTurnReceipt) => void;
  maxBudgetUsd?: number;
  /** Per-turn token ceiling forwarded to each agentLoop call (default 250000). */
  tokenBudget?: number;
  /**
   * Cost meter injected by the caller (router.meteredCost). Core cannot import
   * the price table (surface), so the default is unknown — never a 0 that
   * would let a dollar ceiling pass unmeasured.
   */
  estimateCost?: (buckets: LoopResult["usageByModel"]) => number | null;
  /** Abort for the whole loop: forwarded to every verify spawn. */
  signal?: AbortSignal;
  /** Verify wall timeout in ms (default 60000). Injectable for tests. */
  verifyTimeoutMs?: number;
};

const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;
const DEFAULT_PER_TURN_BUDGET = 250_000;
const MAX_GOAL_TURNS = 100;

export function runVerify(
  cmd: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_VERIFY_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const shell = process.platform === "win32" ? "powershell" : "sh";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", cmd] : ["-c", cmd];
    let settled = false;
    let child: ReturnType<typeof spawn> | undefined;
    const killChild = (): void => {
      // Single-pid kill, not a group kill: no detached:true here, so
      // grandchildren can survive. The comment used to claim otherwise.
      try {
        if (child?.pid !== undefined) child.kill("SIGKILL");
      } catch { /* best-effort: the close handler settles false anyway */ }
    };
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      // Timeout is a refusal, not a hang: kill the child so a sleeping
      // verify cannot outlive the loop that timed it out.
      killChild();
      settle(false);
    }, timeoutMs);
    const onAbort = (): void => {
      killChild();
      settle(false);
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      clearTimeout(timer);
      settle(false);
      return;
    }
    // spawn reports ENOENT/bad-cwd async via the error event (the try/catch
    // only covers a synchronous throw, e.g. a non-string cwd type). Keep
    // both: the sync arm for the type error, the event for the real world.
    try {
      // Verify output never enters the transcript: stdout+stderr are
      // drained, not piped, so a chatty verify cannot hang the loop on
      // backpressure. The boolean is the whole contract.
      child = spawn(shell, args, { cwd, stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve(false);
      return;
    }
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}

export async function runGoalLoop(opts: GoalOpts): Promise<GoalResult> {
  if (!Number.isInteger(opts.maxTurns) || opts.maxTurns < 1 || opts.maxTurns > MAX_GOAL_TURNS) {
    throw new Error(`runGoalLoop: maxTurns must be an integer 1..${MAX_GOAL_TURNS}`);
  }
  if (opts.tokenBudget !== undefined && (!Number.isFinite(opts.tokenBudget) || opts.tokenBudget < 1)) {
    throw new Error("runGoalLoop: tokenBudget must be a finite number >= 1");
  }
  if (opts.maxBudgetUsd !== undefined && (!Number.isFinite(opts.maxBudgetUsd) || opts.maxBudgetUsd < 0)) {
    throw new Error("runGoalLoop: maxBudgetUsd must be a finite number >= 0");
  }
  if (opts.verifyTimeoutMs !== undefined && (!Number.isFinite(opts.verifyTimeoutMs) || opts.verifyTimeoutMs <= 0)) {
    throw new Error("runGoalLoop: verifyTimeoutMs must be a finite number > 0");
  }
  if (opts.interject === true && opts.readInterject === undefined) {
    throw new Error("runGoalLoop: interject:true needs readInterject (refusing to silently ignore the flag)");
  }
  if (opts.goal.trim().length === 0) {
    throw new Error("runGoalLoop: goal must be a non-empty string");
  }
  if (opts.prompt.trim().length === 0) {
    throw new Error("runGoalLoop: prompt must be a non-empty string");
  }
  // Fail closed on unknown spend: a dollar ceiling against an unpriced
  // route stops before turn 1, like index.ts refusing --max-budget-usd
  // on an untracked provider:model. Burning blind to maxTurns is not honest.
  if (opts.maxBudgetUsd !== undefined && opts.estimateCost === undefined) {
    throw new Error("runGoalLoop: maxBudgetUsd needs estimateCost (refusing to budget unmetered spend)");
  }
  const maxTurns = opts.maxTurns;
  const perTurnBudget = opts.tokenBudget ?? DEFAULT_PER_TURN_BUDGET;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  const meter = opts.estimateCost;
  const receipts: GoalTurnReceipt[] = [];
  let history: LoopMsg[] = [];
  let totalCost: number | null = 0;
  // An interjected line steers the NEXT turn's prompt — it never runs its
  // own agentLoop call. The old shape ran two turns per loop iteration
  // (receipts outnumbered turns, maxTurns stopped meaning turns).
  let pendingSteer: string | undefined;
  // Last turn's result, kept outside the loop so the max_turns exit below
  // returns the real tail instead of narrowing an undefined.
  let done: { turns: number; receipts: GoalTurnReceipt[]; finalResult: LoopResult; stopReason: GoalStopReason } | undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (opts.signal?.aborted === true) {
      if (receipts.length === 0) {
        const cancelled: LoopResult = {
          text: "", runId: "cancelled", stopReason: "cancelled",
          promptTokens: 0, completionTokens: 0, usageByModel: [],
          waitedMs: 0, failovers: [], steps: 0, toolCalls: 0, trace: [],
          cancelled: true, checkpoints: 0,
          compact: { events: 0, truncated: 0, dropped: 0 }, repeatCalls: 0,
          messages: [], contextShape: { system: 0, tools: 0, ceiling: 0 },
        };
        return { turns: 0, receipts, finalResult: cancelled, stopReason: "cancelled" };
      }
      break;
    }
    const base = turn === 1
      ? opts.prompt
      : `Continue working toward the goal: "${opts.goal}".\nPick up where you left off. The next turn's verify command will grade your progress.`;
    const prompt = pendingSteer !== undefined
      ? `${base}\nHuman steer for this turn: ${pendingSteer}`
      : base;
    pendingSteer = undefined;

    let lastResult: LoopResult;
    try {
      lastResult = await opts.agentLoop(prompt, history, perTurnBudget);
    } catch (err) {
      // A rejecting agentLoop is a turn error, not an escape hatch: return
      // a GoalResult with the receipts so far, like the error-string path.
      const message = err instanceof Error ? err.message : String(err);
      const failed: LoopResult = {
        text: "", runId: "thrown", error: message, stopReason: "error",
        promptTokens: 0, completionTokens: 0, usageByModel: [],
        waitedMs: 0, failovers: [], steps: 0, toolCalls: 0, trace: [],
        cancelled: false, checkpoints: 0,
        compact: { events: 0, truncated: 0, dropped: 0 }, repeatCalls: 0,
        messages: history, contextShape: { system: 0, tools: 0, ceiling: 0 },
      };
      return { turns: turn, receipts, finalResult: failed, stopReason: "error" };
    }
    if (meter !== undefined) {
      const leg = meter(lastResult.usageByModel);
      totalCost = totalCost === null || leg === null ? null : totalCost + leg;
    } else {
      // No meter injected: the run's cost is unknown, not zero. A dollar
      // ceiling against unknown spend refuses to pretend — same contract
      // as index.ts on an unpriced route.
      totalCost = null;
    }

    const receipt: GoalTurnReceipt = {
      turn,
      runId: lastResult.runId,
      stopReason: lastResult.stopReason,
      promptTokens: lastResult.promptTokens,
      completionTokens: lastResult.completionTokens,
      totalCostUsd: totalCost,
      costUsd: totalCost,
    };
    receipts.push(receipt);
    opts.onTurn?.(receipt);

    if (lastResult.error !== undefined || lastResult.cancelled) {
      return { turns: turn, receipts, finalResult: lastResult, stopReason: lastResult.cancelled ? "cancelled" : "error" };
    }

    // Strip system messages by role, not position: the loop rebuilds the
    // system prompt fresh per turn (same rule as cmdRun's continued).
    history = lastResult.messages.filter((m) => m.role !== "system");

    // Verify is the source of truth and always runs when set — even when
    // the model claims it is done. A clean complete with no tool calls
    // still needs the gate; otherwise a lying model skips verification.
    if (opts.verifyCmd !== undefined) {
      const passed = await runVerify(opts.verifyCmd, opts.cwd, opts.signal, verifyTimeoutMs);
      if (passed) {
        return { turns: turn, receipts, finalResult: lastResult, stopReason: "verify_passed" };
      }
      // Verify failed: keep turning unless a ceiling says stop. A model
      // that is done AND failing verify is not complete — it is wrong.
    } else if (lastResult.stopReason === "complete" && lastResult.toolCalls === 0) {
      return { turns: turn, receipts, finalResult: lastResult, stopReason: "complete" };
    }

    if (opts.maxBudgetUsd !== undefined && totalCost !== null && totalCost >= opts.maxBudgetUsd) {
      return { turns: turn, receipts, finalResult: lastResult, stopReason: "budget_met" };
    }

    if (opts.interject === true && turn < maxTurns) {
      const line = await opts.readInterject?.();
      if (line !== undefined && line.trim().length > 0) {
        pendingSteer = line.trim();
      }
    }
    if (opts.signal?.aborted) {
      return { turns: turn, receipts, finalResult: lastResult, stopReason: "cancelled" };
    }
    // Last turn spent with no stop condition: record the tail and fall out.
    // The exit below returns it — no dead throw, no undefined narrowing.
    if (turn >= maxTurns) {
      done = { turns: maxTurns, receipts, finalResult: lastResult, stopReason: "max_turns" };
      break;
    }
  }

  if (done !== undefined) return done;
  // Aborted before turn 1 with no receipts: receipts is empty here, so the
  // only exit is this synthetic cancelled result. Every other path returns
  // from inside the loop.
  const cancelled: LoopResult = {
    text: "", runId: "cancelled", stopReason: "cancelled",
    promptTokens: 0, completionTokens: 0, usageByModel: [],
    waitedMs: 0, failovers: [], steps: 0, toolCalls: 0, trace: [],
    cancelled: true, checkpoints: 0,
    compact: { events: 0, truncated: 0, dropped: 0 }, repeatCalls: 0,
    messages: [], contextShape: { system: 0, tools: 0, ceiling: 0 },
  };
  return { turns: 0, receipts, finalResult: cancelled, stopReason: "cancelled" };
}
