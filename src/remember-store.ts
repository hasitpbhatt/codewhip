import * as fs from "node:fs";
import * as path from "node:path";
import type { Shape } from "./remember.js";

export type RememberedRule = {
  tool: "bash" | "edit" | "write";
  shape: string;
  /** When the rule was created. */
  ts: string;
  /** Run that created the rule (for audit). */
  runId: string;
  /** Hash of the preview at approval time. */
  preview_hash: string;
};

/** Read remembered rules from .codewhip/remembered.jsonl. Fail-closed. */
export function listRules(cwd: string): RememberedRule[] {
  const file = path.join(cwd, ".codewhip", "remembered.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rules: RememberedRule[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as RememberedRule;
      if (r.tool && r.shape && r.ts && r.runId) rules.push(r);
    } catch {
      // malformed line, skip
    }
  }
  return rules;
}

/**
 * Append one remembered rule as a JSONL line to .codewhip/remembered.jsonl.
 * Returns "added" | "exists" | "error". Fail-closed on disk errors.
 */
export function persistRule(cwd: string, runId: string, rule: RememberedRule): "added" | "exists" | "error" {
  const dir = path.join(cwd, ".codewhip");
  const file = path.join(dir, "remembered.jsonl");
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return "error";
  }
  // Idempotence: don't duplicate the same shape+tool.
  const existing = listRules(cwd);
  if (existing.some((r) => r.tool === rule.tool && r.shape === rule.shape)) {
    return "exists";
  }
  try {
    fs.appendFileSync(file, JSON.stringify(rule) + "\n", "utf8");
    return "added";
  } catch {
    return "error";
  }
}
