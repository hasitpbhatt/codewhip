import type { ToolContext, ToolName, ToolResult } from "./types.js";
import { isToolName } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import { filtersToolEntirely, type ToolFilter } from "../tool-filter.js";
import { isReadArgs, readTool } from "./read.js";
import { isSearchArgs, searchTool } from "./search.js";
import { isEditArgs, editTool } from "./edit.js";
import { isWriteArgs, writeTool } from "./write.js";
import { BASH_TIMEOUT_MS, bashTool, isBashArgs } from "./bash.js";
import { WEBFETCH_TIMEOUT_MS, isWebfetchArgs, webfetchTool } from "./webfetch.js";
import { delegateTool } from "./delegate.js";
import { delegateManyTool } from "./delegate_many.js";
import { runInBackgroundTool, taskOutputTool, taskStopTool } from "./background-tools.js";
import { isTodoArgs, todoTool } from "./todo.js";

// NOTE (principal review): AGENTS.md says "Zod-validated", but package.json
// carries zero runtime deps. Week-1 ships static OpenAI specs + per-tool
// type-guards instead. The zod decision lands Week-2 with the required
// one-paragraph justification — or guards become permanent by evidence.

export type ToolExec = (
  ctx: ToolContext,
  args: unknown,
  signal?: AbortSignal
) => Promise<ToolResult>;

export type ToolDef = {
  name: ToolName;
  spec: ToolSpec;
  timeoutMs: number;
  exec: ToolExec;
};

/**
 * A tool the CALLER supplies — the programmatic entry's `tool()` (see
 * `src/sdk.ts`). Structurally a `ToolDef` whose name is not one of the twelve
 * builtins, which is why it is its own type instead of a widened `ToolDef`:
 * every builtin-only decision (policy row, remembered shape, `--allowed-tools`
 * shape grammar) can then ask `isToolName` and fail closed.
 */
export type HostToolDef = {
  name: string;
  spec: ToolSpec;
  timeoutMs: number;
  exec: ToolExec;
};

export type AnyToolDef = ToolDef | HostToolDef;

/**
 * Provider-side function names are `[a-zA-Z0-9_-]{1,64}`; the lowercase form
 * is required so a host tool can never shadow a builtin by case-folding
 * (`Read`/`READ` would otherwise dodge the collision check and the audit
 * reader's expectations).
 */
export const HOST_TOOL_NAME_RX = /^[a-z][a-z0-9_-]{0,63}$/;
export const HOST_TOOL_TIMEOUT_MIN_MS = 100;
export const HOST_TOOL_TIMEOUT_MAX_MS = 120_000;

/** Why a host tool cannot be offered, or null when it can. */
export function hostToolProblem(def: HostToolDef): string | null {
  if (!HOST_TOOL_NAME_RX.test(def.name)) {
    return `"${def.name}" is not a tool name: lowercase letter, then up to 63 of [a-z0-9_-]`;
  }
  if (isToolName(def.name)) return `"${def.name}" is a built-in tool — a host tool cannot shadow it`;
  if (def.spec.name !== def.name) return `spec.name "${def.spec.name}" does not match name "${def.name}"`;
  const params = def.spec.parameters as { type?: unknown } | null;
  if (typeof params !== "object" || params === null || params.type !== "object") {
    return `"${def.name}" needs parameters: { type: "object", … } — the top level of a tool call is an object`;
  }
  if (typeof def.exec !== "function") return `"${def.name}" has no exec`;
  if (!Number.isInteger(def.timeoutMs) || def.timeoutMs < HOST_TOOL_TIMEOUT_MIN_MS || def.timeoutMs > HOST_TOOL_TIMEOUT_MAX_MS) {
    return `"${def.name}" timeout must be an integer between ${HOST_TOOL_TIMEOUT_MIN_MS}ms and ${HOST_TOOL_TIMEOUT_MAX_MS}ms`;
  }
  return null;
}

function readSpec(): ToolSpec {
  return {
    name: "read",
    description: "Read a file with line numbers. Args: path (workspace-relative), offset (1-based), limit.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "integer", minimum: 1 },
        limit: { type: "integer", minimum: 1, maximum: 2000 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

function searchSpec(): ToolSpec {
  return {
    name: "search",
    description: "Grep a regex across workspace files. Args: query (regex), glob (e.g. *.ts). Secrets and binaries are skipped.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        glob: { type: "string" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  };
}

function editSpec(): ToolSpec {
  return {
    name: "edit",
    description: "Replace exactly one occurrence of oldString with newString in a file. Args: path, oldString, newString.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
      },
      required: ["path", "oldString", "newString"],
      additionalProperties: false,
    },
  };
}

function writeSpec(): ToolSpec {
  return {
    name: "write",
    description: "Create or fully overwrite a workspace file. Args: path, content (string written verbatim; parent dirs created). Refuses .codewhip/** and codewhip-policy.yaml. Ask-gated in policy.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  };
}

function bashSpec(): ToolSpec {
  return {
    name: "bash",
    description: "One plain shell command (PowerShell on win32). cwd-jailed, timeout-killed. Denied: chaining (;|&), redirection (< >), backticks, $(), newlines — one command per call. Destructive commands are denied, never ask. Use read/write/edit for file work. Args: command, timeoutMs.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  };
}

function webfetchSpec(): ToolSpec {
  return {
    name: "webfetch",
    description: "Fetch one https page for reading; links survive text mode as [text](url). Args: url (https only), format (text|html, default text). Ask per host; 30s timeout, 1MB cap, secrets redacted. 404/timeout/network → vary the URL (another path or a results/JSON page). 403/429 → the host refuses agents; another path won't help — another source, or report honestly. Never invent the page's content.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        format: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
  };
}

function todoSpec(): ToolSpec {
  return {
    name: "todo",
    description:
      "Maintain this run's task list in harness state (.codewhip/todos.json; never touches workspace files). " +
      "action: list (the plan, one line per item) | get (one item in full: its contract, owner, blockers and what is ready to claim) | " +
      "replace (the FULL new list) | update (one item's status by id). " +
      "Item = {id,text,status:pending|in_progress|done} plus optional description (what finishing means), activeForm (present-continuous label while in progress), " +
      "owner, and blocks/blockedBy (ids this item gates, or gates it). Either edge direction is enough — both are stored. " +
      "Rules, enforced rather than advised: unique short ids, <=64 items, at most one in_progress, an edge must name an id in the list, " +
      "a cycle is refused, and a blocked item cannot be claimed until every blocker is done. " +
      "Plan with replace up front, update per step, get before picking up someone else's item.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get", "replace", "update"] },
        items: { type: "array" },
        id: { type: "string" },
        status: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  };
}

export const TOOLS: Record<ToolName, ToolDef> = {  read: {
    name: "read",
    spec: readSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, _signal) =>
      isReadArgs(args) ? readTool(ctx, args) : Promise.resolve({ ok: false, output: "read: bad args" } as ToolResult),
  },
  search: {
    name: "search",
    spec: searchSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, _signal) =>
      isSearchArgs(args) ? searchTool(ctx, args) : Promise.resolve({ ok: false, output: "search: bad args" } as ToolResult),
  },
  edit: {
    name: "edit",
    spec: editSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, _signal) =>
      isEditArgs(args) ? editTool(ctx, args) : Promise.resolve({ ok: false, output: "edit: bad args" } as ToolResult),
  },
  write: {
    name: "write",
    spec: writeSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, _signal) =>
      isWriteArgs(args) ? writeTool(ctx, args) : Promise.resolve({ ok: false, output: "write: bad args" } as ToolResult),
  },
  bash: {
    name: "bash",
    spec: bashSpec(),
    timeoutMs: BASH_TIMEOUT_MS,
    exec: (ctx, args, signal) =>
      isBashArgs(args) ? bashTool(ctx, args, signal) : Promise.resolve({ ok: false, output: "bash: bad args" } as ToolResult),
  },
  webfetch: {
    name: "webfetch",
    spec: webfetchSpec(),
    // Loop-level wall clock sits just above the tool's own 30s abort so the
    // tool always reports its own timeout message first (bash pairs equal
    // values the same way).
    timeoutMs: WEBFETCH_TIMEOUT_MS + 5000,
    exec: (ctx, args, signal) =>
      isWebfetchArgs(args) ? webfetchTool(ctx, args, signal) : Promise.resolve({ ok: false, output: "webfetch: bad args" } as ToolResult),
  },
  delegate: delegateTool,
  delegate_many: delegateManyTool,
  run_in_background: runInBackgroundTool,
  task_output: taskOutputTool,
  task_stop: taskStopTool,
  todo: {
    name: "todo",
    spec: todoSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, _signal) =>
      isTodoArgs(args) ? todoTool(ctx, args) : Promise.resolve({ ok: false, output: "todo: bad args" } as ToolResult),
  },
};

/**
 * Tool specs by delegation depth: a top-level run (depth 0) sees everything
 * including the delegation tools; a child (depth >= 1) sees ONLY read+search —
 * delegate tools are absent (depth guard), mutating tools are absent
 * (children are read-only), and webfetch is absent (children have no network;
 * the parent fetches and passes content). Advertising tools we refuse would
 * burn child tokens on refused calls. Filter at construction, not per call,
 * so the transcript and failover paths keep their same-specs assumption.
 *
 * `--disallowed-tools` applies the same principle to a single run: a tool the
 * human filtered out is not advertised, so the model is never tempted into a
 * call the harness already refuses. Shape-scoped entries (one path, one host,
 * one command head) keep the spec advertised — the tool is in play, a slice of
 * it is not, and that slice is enforced where the call is graded.
 */
export function toolSpecs(depth = 0, disallowed?: readonly ToolFilter[], hosts?: readonly HostToolDef[]): ToolSpec[] {
  // A `--disallowed-tools` entry names one of the twelve (its shape grammar is
  // path/command/origin), so it can never address a host tool — the caller of
  // `query()` drops a host tool by not passing it.
  const visible = (name: string): boolean => !isToolName(name) || !filtersToolEntirely(disallowed, name);
  if (depth > 0) {
    // A child is read-only and effect-free, so a host tool — whose body is
    // arbitrary caller code running with the parent's authority — is not
    // offered to it. Advertising what the harness would refuse burns tokens.
    return [TOOLS.read.spec, TOOLS.search.spec].filter((s) => visible(s.name));
  }
  return [
    TOOLS.read.spec,
    TOOLS.search.spec,
    TOOLS.edit.spec,
    TOOLS.write.spec,
    TOOLS.bash.spec,
    TOOLS.webfetch.spec,
    TOOLS.delegate.spec,
    TOOLS.delegate_many.spec,
    TOOLS.run_in_background.spec,
    TOOLS.task_output.spec,
    TOOLS.task_stop.spec,
    TOOLS.todo.spec,
    ...(hosts ?? []).map((h) => h.spec),
  ].filter((s) => visible(s.name));
}
