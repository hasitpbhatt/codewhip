import type { ChatPort } from "../provider-port.js";
import type { UsageBucket } from "../outcomes.js";
import type { Debug } from "../debug.js";
import type { ToolFilter } from "../tool-filter.js";

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
  "ask_user",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The whole authority a delegated child is *offered*. Two decisions have to
 * agree on this pair: what `toolSpecs` advertises at depth > 0, and what an
 * agent file's `tools:` frontmatter may name — a second copy of the list is how
 * an agent file starts naming tools its child cannot use. The loop's own
 * per-name child refusals (`loop:child-readonly` and friends) stay the belt for
 * a call that asks for something unadvertised.
 */
export const CHILD_TOOL_NAMES: readonly ToolName[] = ["read", "search"];

/**
 * Is this wire name one of the thirteen? The only honest answer to every
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

/** One multiple-choice question put to the human who started the run. */
export type UserQuestion = {
  question: string;
  options: readonly string[];
  /** True when more than one option may be chosen. */
  multiSelect: boolean;
};

/**
 * The question channel, injected only where a human is actually reachable.
 * Resolves to the chosen option labels (or one free-text answer — the human may
 * always say something else), or null for no answer: interrupted, or the mode
 * has no keyboard. Rendering is the asker's business; a caller that owns the
 * terminal shows numbers, a caller that owns a UI shows buttons.
 */
export type AskUserQuestion = (q: UserQuestion, signal?: AbortSignal) => Promise<string[] | null>;

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
  /**
   * This run's `--disallowed-tools` refusals, forwarded so they cross the
   * delegation boundary. A run-scoped refusal is defined as ungrantable — "no
   * --yolo, remembered rule or human yes" — and a child that could re-read what
   * the operator filtered out would make that sentence false. Grants
   * (`--allowed-tools`) are deliberately NOT inherited: delegation buys
   * authority to nothing the parent did not already have.
   */
  disallowedTools?: readonly ToolFilter[];
  /**
   * The question channel for `ask_user`. Present only when a human is
   * reachable at a keyboard: absent for headless runs and for children, which
   * is what makes the tool's refusal the honest answer rather than a hang.
   */
  askUserQuestion?: AskUserQuestion;
  /** This run's runId — present when invoked from the loop; lets tools (e.g.
   *  background tasks) write audit entries under the correct run without a
   *  separate plumbing path. */
  runId?: string;
};
