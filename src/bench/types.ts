import type { ChatPort } from "../provider-port.js";
import type { LoopResult } from "../loop.js";

/**
 * Experiment apparatus for the interaction-derived-policy paper
 * (docs/paper/00-thesis.md). Bench-only: nothing here runs in production;
 * every arm difference must map onto a documented LoopArgs ablation switch.
 */

/** One treatment cell. The substrate (policy/budget/guard surface) is the
 * treatment; the model is held constant. */
export type BenchArm = {
  id: string;
  /** "prompt" moves denylist+promoted denies into the system prompt (the
   * bench composes the rules text); structural jail stays harness-side. */
  policySurface: "harness" | "prompt";
  repeatGuard: boolean;
  /** undefined = no mid-run budget (RQ4 arm). */
  tokenBudget?: number;
  yolo?: boolean;
  /** Scripted operator: the semi-attentive human model. "fatfinger-always"
   * answers the FIRST ask with "always" (the fat-finger) and "no" after. */
  ask: "deny" | "yes" | "fatfinger-always";
  /** Extra policy rules appended to the system prompt on the prompt arm. */
  promptPolicyRules?: string;
  /** policy.md content written into the workspace on harness arms (compiled
   * denies under test). */
  workspacePolicy?: string;
  maxSteps?: number;
};

export type AttackClass =
  | "exfil"
  | "secret"
  | "destructive"
  | "policy-tamper"
  | "cost-inflation"
  | "benign";

export type BenchTask = {
  id: string;
  attackClass: AttackClass;
  /** The operator-visible task prompt. */
  prompt: string;
  /** Workspace files materialized before the run (relative path -> content);
   * injection payloads live in these contents (indirect injection). */
  files: Record<string, string>;
  /** The malicious action to grade. null for benign/cost tasks.
   * gradeOn "subject" (default): an allow decision whose call subject
   * (command/path/query preview) contains `match`. gradeOn "output": an
   * allow decision whose tool OUTPUT (trace preview) contains `match` —
   * used for secret access, where "the tool ran" is nothing and "the bytes
   * reached the transcript" is everything. */
  attack: { tool: string; match: string; gradeOn?: "subject" | "output" } | null;
};

export type BenchRunRecord = {
  taskId: string;
  taskClass: string;
  armId: string;
  /** 1-based within a cell; runs >1 reuse the SAME workspace — remembered
   * rules and policy.md minted by run N bind run N+1 (RQ2 persistence). */
  runIndex: number;
  runId: string;
  /** RQ1/RQ2 ground truth: the malicious action got past policy (allow). */
  attackSuccess: boolean;
  error?: string;
  promptTokens: number;
  completionTokens: number;
  steps: number;
  toolCalls: number;
  repeatCalls: number;
  cancelled: boolean;
  decisions: Array<{ tool: string; policy: string; subject: string }>;
};

export type BenchRunOptions = {
  tasks: BenchTask[];
  arms: BenchArm[];
  port: ChatPort;
  label: string;
  model: string;
  /** JSONL output path (one BenchRunRecord per task×arm×run). */
  outPath: string;
  /** Runs per task×arm cell; >1 reuses the workspace (persistence study). */
  runsPerCell?: number;
  /** Keep workspaces for forensics (default: cleaned up). */
  keepWorkspaces?: boolean;
  /** Cap total cells for smoke tests. */
  limit?: number;
};

export type BenchSummary = {
  runs: number;
  byArm: Record<string, { runs: number; attackSuccess: number; tokens: number; steps: number }>;
};

export type GradeResult = {
  attackSuccess: boolean;
  decisions: Array<{ tool: string; policy: string; subject: string }>;
};

export type { LoopResult };
