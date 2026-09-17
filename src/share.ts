import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256Hex } from "./hash.js";
import { redactEnvValues, redactSecrets } from "./redact.js";
import { chainTail, signBlob } from "./audit.js";
import type { LoopTraceCall } from "./loop.js";
import type { UsageBucket } from "./outcomes.js";

export const SHARE_SCHEMA_V = 1;

export type ShareToolCall = {
  seq: number;
  tool: string;
  policy: string;
  actor: string;
  preview_redacted: string;
};

export type ShareBundle = {
  v: 1;
  ts: string;
  runId: string;
  model: string;
  prompt_redacted: string;
  result_redacted: string;
  error: string | null;
  tool_calls: ShareToolCall[];
  usage: { prompt: number; completion: number };
  usageByModel: UsageBucket[];
  receipt: string;
  /** Hash of the last audit.log entry — anchors this share to the chain. */
  audit_tail: string;
  bundle_sig: string | null;
};

export type ShareInput = {
  runId: string;
  model: string;
  prompt: string;
  resultText: string;
  error?: string;
  trace: LoopTraceCall[];
  promptTokens: number;
  completionTokens: number;
  usageByModel: UsageBucket[];
  receipt: string;
};

/**
 * Redacted run bundle for sharing with a teammate: prompt, per-tool
 * previews (already redacted at the model boundary), policy verdicts, and
 * the receipt — never raw args or output. Env-style assignments get an extra
 * scrub (names kept, values masked). Anchored to audit.log via audit_tail
 * and signed with the repo key when present. Local-file v1: no upload, no
 * server — the "link" is the bundle path plus its content hash.
 */
export function buildShareBundle(cwd: string, input: ShareInput): { bundle: ShareBundle; json: string } {
  const scrub = (s: string): string => redactEnvValues(redactSecrets(s)).slice(0, 2000);
  const base = {
    v: 1 as const,
    ts: new Date().toISOString(),
    runId: input.runId,
    model: input.model,
    prompt_redacted: scrub(input.prompt),
    result_redacted: scrub(input.resultText),
    error: input.error === undefined ? null : scrub(input.error),
    tool_calls: input.trace.map((t) => ({
      seq: t.seq,
      tool: t.tool,
      policy: t.policy,
      actor: t.actor,
      preview_redacted: scrub(t.preview).slice(0, 500),
    })),
    usage: { prompt: input.promptTokens, completion: input.completionTokens },
    usageByModel: input.usageByModel,
    receipt: input.receipt,
    audit_tail: chainTail(cwd),
  };
  const bundle: ShareBundle = { ...base, bundle_sig: signBlob(cwd, canonicalJson(base)) };
  return { bundle, json: JSON.stringify(bundle) };
}

export function sharePath(cwd: string, runId: string): string {
  return path.join(cwd, ".codewhip", `share-${runId}.json`);
}

/** Write the bundle. Returns path + content hash (the shareable link) + bundle. */
export function writeShareBundle(cwd: string, input: ShareInput): { path: string; hash: string; bundle: ShareBundle } | { error: string } {
  try {
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    const { bundle, json } = buildShareBundle(cwd, input);
    const outPath = sharePath(cwd, input.runId);
    fs.writeFileSync(outPath, json + "\n", "utf8");
    return { path: outPath, hash: sha256Hex(json), bundle };
  } catch {
    return { error: "share: failed to write bundle (disk write)" };
  }
}

function oneLine(s: string): string {
  return s.replace(/[\r\n|]+/g, " ").slice(0, 120);
}

/**
 * Pasteable Markdown receipt block for `run --share --print`: the same
 * redacted bundle, rendered for chat/PR paste. Anchored via audit_tail +
 * bundle hash — a reader verifies with `codewhip audit --verify`.
 */
export function renderShareMarkdown(bundle: ShareBundle, hash: string): string {
  const deny = bundle.tool_calls.filter((t) => t.policy.startsWith("deny")).length;
  const allow = bundle.tool_calls.filter((t) => t.policy.startsWith("allow")).length;
  const lines = [
    `## codewhip run ${bundle.runId} (${bundle.model}, ${bundle.ts})`,
    ``,
    `${bundle.receipt}`,
    `usage: ${bundle.usage.prompt} prompt + ${bundle.usage.completion} completion tokens`,
    `decisions: ${allow} allow / ${deny} deny across ${bundle.tool_calls.length} tool call(s)`,
    ``,
    `result: ${bundle.result_redacted}`,
  ];
  if (bundle.error !== null) lines.push(`error: ${bundle.error}`);
  lines.push(``, `| seq | tool | policy | preview |`, `| --- | --- | --- | --- |`);
  for (const t of bundle.tool_calls) {
    lines.push(`| ${t.seq} | ${t.tool} | ${t.policy} | ${oneLine(t.preview_redacted)} |`);
  }
  lines.push(
    ``,
    `audit_tail: ${bundle.audit_tail === "" ? "(no chain yet)" : bundle.audit_tail}`,
    `bundle sha256: ${hash}`,
    `signature: ${bundle.bundle_sig ?? "unsigned (no repo key)"} — verify: codewhip audit --verify`,
  );
  return lines.join("\n");
}