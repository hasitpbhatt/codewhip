import type { Permission, ToolName } from "./tools/types.js";

const DENY_PATTERNS: string[] = [
  "rm -rf /",
  "git push --force",
  "mkfs",
  ":(){:|:&};:",
];

const SAFE_BASH_PREFIXES: string[] = ["git status", "git diff", "ls", "dir"];

export function checkPermission(tool: ToolName, commandPreview: string): Permission {
  for (const p of DENY_PATTERNS) {
    if (commandPreview.includes(p)) {
      return "deny";
    }
  }
  if (tool === "read" || tool === "search") {
    return "allow";
  }
  if (tool === "bash") {
    for (const safe of SAFE_BASH_PREFIXES) {
      if (commandPreview.startsWith(safe)) {
        return "allow";
      }
    }
    return "ask";
  }
  return "ask";
}

export function describePolicy(): string {
  return "defaults read:allow edit:ask shell:ask external:deny (ask-default)";
}
