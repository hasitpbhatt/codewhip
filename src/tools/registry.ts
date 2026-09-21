import type { ToolContext, ToolName, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import { isReadArgs, readTool } from "./read.js";
import { isSearchArgs, searchTool } from "./search.js";
import { isEditArgs, editTool } from "./edit.js";
import { isWriteArgs, writeTool } from "./write.js";
import { BASH_TIMEOUT_MS, bashTool, isBashArgs } from "./bash.js";
import { WEBFETCH_TIMEOUT_MS, isWebfetchArgs, webfetchTool } from "./webfetch.js";
import { delegateTool } from "./delegate.js";
import { delegateManyTool } from "./delegate_many.js";
import { runInBackgroundTool, taskOutputTool, taskStopTool } from "./background.js";
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
    description: "Maintain this run's task checklist in harness state (.codewhip/todos.json; never touches workspace files). Args: action (list|replace|update); items for replace = the FULL new list of {id,text,status:pending|in_progress|done} (unique short ids, <=64 items, at most one in_progress — replaces the store); id+status for update. Plan with replace up front, update per step, list to re-read.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "replace", "update"] },
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
 */
export function toolSpecs(depth = 0): ToolSpec[] {
  if (depth > 0) {
    return [TOOLS.read.spec, TOOLS.search.spec];
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
  ];
}
