import type { ChatPort } from "../provider-port.js";
import type { UsageBucket } from "../outcomes.js";
import type { Debug } from "../debug.js";

/**
 * Every tool name, as data — the union is derived from this list, so a new
 * tool has one place to be declared. Registry-ordered consumers (`toolSpecs`,
 * `lookupTool`) and the CLI filter parser check against it;
 * `tool-filter.test.ts` pins it to the keys of `TOOLS`.
 */
export const TOOL_NAMES = [
  "read",
  "search",
  "edit",
  "write",
  "bash",
  "webfetch",
  "delegate",
  "delegate_many",
  "run_in_background",
  "task_output",
  "task_stop",
  "todo",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * Is this wire name one of the twelve? The only honest answer to every
 * builtin-only question — a policy row, a remembered shape, a
 * `--allowed-tools` grammar, a checkpoint — since a name reaching the loop can
 * also be a host-provided tool (`src/sdk.ts`). Lives here, next to the list it
 * reads, so no module has to import the registry to ask it.
 */
export function isToolName(name: string): name is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(name);
}

export type ToolResult = {
  ok: boolean;
  output: string;
};

export type Permission = "allow" | "ask" | "deny";

export type ToolContext = {
  cwd: string;
  /**
   * Realpath'd extra jail roots (--add-dir / settings). Containment only: the
   * secret-file and self-protected checks still apply inside them.
   */
  roots?: readonly string[];
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
  /** Parent's `--debug` sink, forwarded so a child's ladder decisions land on
   * the same log that is being read (children are where surprises hide). */
  debug?: Debug;
  /** This run's runId — present when invoked from the loop; lets tools (e.g.
   *  background tasks) write audit entries under the correct run without a
   *  separate plumbing path. */
  runId?: string;
};
