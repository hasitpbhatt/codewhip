import * as fs from "node:fs";
import * as path from "node:path";
import { isValidStoredShape } from "./remember.js";

export type RememberedRule = {
  tool: "bash" | "edit" | "write" | "webfetch";
  shape: string;
  /** When the rule was created. */
  ts: string;
  /** Run that created the rule (for audit). */
  runId: string;
  /** Hash of the preview at approval time. */
  preview_hash: string;
};

/** Read remembered rules. Fail-closed; re-validates every line so a
 * hand-edited file can't inject shapes the curator would never store
 * (and provenance-free rules — what Ruling 4 forbids — never load). */
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
      if (
        typeof r.tool === "string" &&
        typeof r.shape === "string" &&
        typeof r.ts === "string" &&
        typeof r.runId === "string" &&
        typeof r.preview_hash === "string" &&
        r.preview_hash.length > 0 &&
        isValidStoredShape(r.tool, r.shape)
      ) {
        rules.push(r);
      }
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

/**
 * Revoke one remembered rule by its `tool:shape` identity. Consent that
 * cannot be revoked is not consent (UX panel): one keystroke grants, so
 * revocation must be one command. Rewrites the JSONL without the rule;
 * other rules are preserved verbatim. Returns false when nothing matched
 * or the disk failed.
 */
export function removeRule(cwd: string, tool: string, shape: string): boolean {
  const file = path.join(cwd, ".codewhip", "remembered.jsonl");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const kept: string[] = [];
  let removed = false;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as RememberedRule;
      if (r.tool === tool && r.shape === shape) {
        removed = true;
        continue;
      }
    } catch {
      // malformed lines are preserved untouched (audit --verify owns integrity)
    }
    kept.push(line);
  }
  if (!removed) return false;
  try {
    fs.writeFileSync(file, kept.length > 0 ? kept.join("\n") + "\n" : "", "utf8");
    return true;
  } catch {
    return false;
  }
}
