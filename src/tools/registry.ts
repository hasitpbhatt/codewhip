import type { ToolContext, ToolName, ToolResult } from "./types.js";
import type { ToolSpec } from "../provider-port.js";
import { isReadArgs, readTool } from "./read.js";
import { isSearchArgs, searchTool } from "./search.js";
import { isEditArgs, editTool } from "./edit.js";
import { isWriteArgs, writeTool } from "./write.js";
import { BASH_TIMEOUT_MS, bashTool, isBashArgs } from "./bash.js";

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
    description: "Run a command via the system shell (PowerShell on Windows, sh elsewhere), cwd-jailed, timeout-killed. Redirection and chaining work. Destructive commands are denied, never ask. Args: command, timeoutMs.",
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

export const TOOLS: Record<ToolName, ToolDef> = {
  read: {
    name: "read",
    spec: readSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, signal) =>
      isReadArgs(args) ? readTool(ctx, args) : Promise.resolve({ ok: false, output: "read: bad args" } as ToolResult),
  },
  search: {
    name: "search",
    spec: searchSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, signal) =>
      isSearchArgs(args) ? searchTool(ctx, args) : Promise.resolve({ ok: false, output: "search: bad args" } as ToolResult),
  },
  edit: {
    name: "edit",
    spec: editSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, signal) =>
      isEditArgs(args) ? editTool(ctx, args) : Promise.resolve({ ok: false, output: "edit: bad args" } as ToolResult),
  },
  write: {
    name: "write",
    spec: writeSpec(),
    timeoutMs: 10000,
    exec: (ctx, args, signal) =>
      isWriteArgs(args) ? writeTool(ctx, args) : Promise.resolve({ ok: false, output: "write: bad args" } as ToolResult),
  },
  bash: {
    name: "bash",
    spec: bashSpec(),
    timeoutMs: BASH_TIMEOUT_MS,
    exec: (ctx, args, signal) =>
      isBashArgs(args) ? bashTool(ctx, args, signal) : Promise.resolve({ ok: false, output: "bash: bad args" } as ToolResult),
  },
};

export function toolSpecs(): ToolSpec[] {
  return [TOOLS.read.spec, TOOLS.search.spec, TOOLS.edit.spec, TOOLS.write.spec, TOOLS.bash.spec];
}
