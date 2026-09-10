import type { Permission, ToolName } from "./tools/types.js";

export type PermissionDecision = {
  decision: Permission;
  /** Auditable rule pointer: denylist:<pattern> | allowlist:<prefix> | default:<scope> */
  ruleId: string;
  reason: string;
};

// Non-overridable: checked first, --yolo never bypasses.
const DENY_PATTERNS: string[] = [
  "rm -rf /",
  "rm -rf ~",
  "git push --force",
  "git push -f",
  "--force-with-lease",
  "mkfs",
  ":(){:|:&};:",
];

const SAFE_BASH_PREFIXES: string[] = ["git status", "git diff", "ls", "dir"];

// Shell chaining breaks prefix allowlisting (e.g. `git status; rm -rf /`).
const CHAIN_RX = /[;&|]|`|\$\(/;

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Non-overridable denylist probe, shared by the loop and bash itself. */
export function matchDenylist(commandPreview: string): string | null {
  const norm = normalize(commandPreview);
  for (const p of DENY_PATTERNS) {
    if (norm.includes(p)) {
      return p;
    }
  }
  return null;
}

export function checkPermission(tool: ToolName, commandPreview: string): PermissionDecision {
  const denied = matchDenylist(commandPreview);
  if (denied !== null) {
    return {
      decision: "deny",
      ruleId: `denylist:${denied}`,
      reason: `matched non-overridable denylist "${denied}"`,
    };
  }
  if (tool === "read" || tool === "search") {
    return {
      decision: "allow",
      ruleId: "default:read:allow",
      reason: "read-only tools are allow by default",
    };
  }
  const norm = normalize(commandPreview);
  if (tool === "bash" && !CHAIN_RX.test(commandPreview)) {
    for (const safe of SAFE_BASH_PREFIXES) {
      if (norm === safe || norm.startsWith(safe + " ")) {
        return {
          decision: "allow",
          ruleId: `allowlist:${safe}`,
          reason: `exact allowlisted prefix "${safe}" with no shell chaining`,
        };
      }
    }
  }
  if (tool === "edit") {
    return { decision: "ask", ruleId: "default:edit:ask", reason: "mutations ask by default" };
  }
  return { decision: "ask", ruleId: "default:shell:ask", reason: "shell asks by default" };
}

export function describePolicy(): string {
  return "defaults read:allow edit:ask shell:ask external:deny (ask-default)";
}
