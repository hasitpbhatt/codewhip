import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopMsg } from "./provider-port.js";
import { redactSecrets } from "./redact.js";
import { writeOwnerOnlyFile } from "./secure-file.js";

/**
 * Opt-in conversation memory (committee verdict: multi-turn).
 * One `{ v: 1, ts, runId, provider, model, messages }` object per session at
 * `.codewhip/sessions/<runId>.json`, rewritten (not appended) at end of each
 * `--continue` run. The system message is stripped on save and rebuilt fresh
 * on resume (roster / plan banner change between runs). Secrets are redacted
 * at write time; raw prompts otherwise stay on disk — hence opt-in only.
 */

export type SessionRecord = {
  v: 1;
  ts: string;
  runId: string;
  provider: string;
  model: string;
  messages: LoopMsg[];
};

export type SessionSummary = {
  runId: string;
  ts: string;
  provider: string;
  model: string;
  /** Stored (system-stripped) message count. */
  messages: number;
  /** Redacted first user-prompt preview, ≤60 chars. */
  preview: string;
  mtimeMs: number;
};

export function sessionDir(cwd: string): string {
  return path.join(cwd, ".codewhip", "sessions");
}

export function sessionPath(cwd: string, runId: string): string {
  return path.join(sessionDir(cwd), `${runId}.json`);
}

function redactMsg(m: LoopMsg): LoopMsg {
  return {
    role: m.role,
    content: redactSecrets(m.content),
    ...(m.toolCallId === undefined ? {} : { toolCallId: m.toolCallId }),
    ...(m.toolCalls === undefined
      ? {}
      : {
          toolCalls: m.toolCalls.map((c) => ({
            id: c.id,
            name: c.name,
            argsJson: redactSecrets(c.argsJson),
          })),
        }),
  };
}

function isRecord(r: unknown): r is SessionRecord {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  return o["v"] === 1 && typeof o["runId"] === "string" && Array.isArray(o["messages"]);
}

/** Persist one session. Strips system messages, redacts secrets, never throws. */
export function saveSession(cwd: string, rec: SessionRecord): boolean {
  try {
    const clean: SessionRecord = {
      v: 1,
      ts: rec.ts,
      runId: rec.runId,
      provider: rec.provider,
      model: rec.model,
      messages: rec.messages.filter((m) => m.role !== "system").map(redactMsg),
    };
    fs.mkdirSync(sessionDir(cwd), { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(sessionDir(cwd), 0o700);
    } catch { /* best-effort */ }
    const p = sessionPath(cwd, rec.runId);
    writeOwnerOnlyFile(p, JSON.stringify(clean) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Prefix resolve over session files (>=4 chars, must be unique). */
export function resolveSession(cwd: string, prefix: string): string | null | "ambiguous" {
  if (prefix.length < 4) return null;
  let files: string[];
  try {
    files = fs.readdirSync(sessionDir(cwd));
  } catch {
    return null;
  }
  const hits = files.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).filter((id) => id.startsWith(prefix));
  if (hits.length === 1) return hits[0] as string;
  return hits.length > 1 ? "ambiguous" : null;
}

/** Load one session: bare prefix = most recent; else that prefix. Never throws. */
export function loadSession(
  cwd: string,
  prefix?: string,
): { ok: true; record: SessionRecord } | { ok: false; error: string } {
  let runId: string;
  if (prefix === undefined || prefix.length === 0) {
    const list = listSessions(cwd);
    if (list.length === 0) return { ok: false, error: "no saved sessions yet (run once with --continue to save one)" };
    runId = (list[0] as SessionSummary).runId;
  } else {
    if (prefix.length < 4) {
      return { ok: false, error: `prefix "${prefix}" is too short (need >=4 chars; see: codewhip sessions)` };
    }
    const resolved = resolveSession(cwd, prefix);
    if (resolved === "ambiguous") return { ok: false, error: `ambiguous prefix "${prefix}" — use more chars (see: codewhip sessions)` };
    if (resolved === null) {
      // A corrupt file still owns its name: surface "corrupt" instead of a
      // misleading "no session" when the name matches but won't parse.
      try {
        const names = fs.readdirSync(sessionDir(cwd));
        const hit = names.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).find((id) => id === prefix || id.startsWith(prefix));
        if (hit !== undefined) return { ok: false, error: `session ${hit.slice(0, 8)} is corrupt (unreadable JSON) — start a fresh run` };
      } catch { /* fall through to the miss */ }
      return { ok: false, error: `no session starts with "${prefix}" (see: codewhip sessions)` };
    }
    runId = resolved;
  }
  try {
    const raw = fs.readFileSync(sessionPath(cwd, runId), "utf8");
    const rec = JSON.parse(raw) as unknown;
    if (!isRecord(rec)) return { ok: false, error: `session ${runId.slice(0, 8)} is corrupt (unreadable JSON) — start a fresh run` };
    return { ok: true, record: rec };
  } catch {
    return { ok: false, error: `session ${runId.slice(0, 8)} is corrupt (unreadable JSON) — start a fresh run` };
  }
}

/** Session summaries, newest-mtime first. Missing/corrupt → skipped, never throws. */
export function listSessions(cwd: string): SessionSummary[] {
  let files: string[];
  try {
    files = fs.readdirSync(sessionDir(cwd));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const p = path.join(sessionDir(cwd), f);
    try {
      const stat = fs.statSync(p);
      const rec = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<SessionRecord>;
      if (rec.v !== 1 || typeof rec.runId !== "string" || !Array.isArray(rec.messages)) continue;
      const firstUser = (rec.messages as LoopMsg[]).find((m) => m.role === "user");
      out.push({
        runId: rec.runId,
        ts: typeof rec.ts === "string" ? rec.ts : "",
        provider: typeof rec.provider === "string" ? rec.provider : "",
        model: typeof rec.model === "string" ? rec.model : "",
        messages: (rec.messages as LoopMsg[]).length,
        preview: redactSecrets(firstUser?.content ?? "").slice(0, 60),
        mtimeMs: stat.mtimeMs,
      });
    } catch { /* corrupt file: skip */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
