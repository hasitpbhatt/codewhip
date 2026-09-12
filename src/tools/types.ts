import type { ChatPort } from "../provider-port.js";
import type { UsageBucket } from "../outcomes.js";

export type ToolName =
  | "read"
  | "search"
  | "edit"
  | "write"
  | "bash"
  | "webfetch"
  | "delegate"
  | "delegate_many";

export type ToolResult = {
  ok: boolean;
  output: string;
};

export type Permission = "allow" | "ask" | "deny";

export type ToolContext = {
  cwd: string;
  /** Present when invoked from the agent loop: parent run context for delegation. */
  port?: ChatPort;
  model?: string;
  label?: string;
  /** Delegation depth of the invoking loop (0 = top-level run). */
  depth?: number;
  /** Fold a child run's usage buckets into the parent's receipt (honest meter). */
  onChildUsage?: (buckets: UsageBucket[]) => void;
  /** Forward child progress lines to the parent's event stream. */
  onChildEvent?: (text: string) => void;
  /** Parent's remaining token budget at exec time — children inherit it so
   * delegation is enforced live, not just metered (undefined = no budget). */
  remainingBudget?: number;
  /** Same-provider rotation candidates + 429 retry-wait, forwarded so a
   * rate-limited child rotates instead of dying (parallel fan-out friendly). */
  rotationModels?: string[];
  retryWait?: boolean;
  /** Parent's compaction ceiling (children share the transcript-size policy). */
  compactTokens?: number;
  /** Parent's runId — stamped on the child's outcome record for attribution. */
  parentRunId?: string;
};
