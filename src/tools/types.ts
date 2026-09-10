export type ToolName = "read" | "search" | "edit" | "bash";

export type ToolResult = {
  ok: boolean;
  output: string;
};

export type Permission = "allow" | "ask" | "deny";

export type ToolContext = {
  cwd: string;
};
