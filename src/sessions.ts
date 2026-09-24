import * as fs from "node:fs";
import * as path from "node:path";
import type { LoopMsg } from "./provider-port.js";
import { redactSecrets } from "./redact.js";
import { writeOwnerOnlyFile } from "./secure-file.js";

/**
 * Opt-in conversation memory (committee verdict: multi-turn).
 * One object per session at `.codewhip/sessions/<sessionId>.json`, rewritten
 * (not appended) at the end of each `--continue` run. `runId` is the session's
 * own identity — the file name, stable across resumes — and `lastRunId` names
 * the most recent run that wrote it, so the audit chain keeps one entry per run
 * while a resumed session stays findable by either id. The system message is
 * stripped on save and rebuilt fresh on resume (roster / plan banner change
 * between runs). Secrets are redacted at write time; raw prompts otherwise stay
 * on disk — hence opt-in only.
 */

export type SessionRecord = {
  v: 1;
  ts: string;
  runId: string;
  provider: string;
  model: string;
  messages: LoopMsg[];
  /** Newest run that wrote this file; equals `runId` for a session never resumed. */
  lastRunId?: string;
  /** Human label — `-r <name>`, `--name`, `/rename`. */
  name?: string;
  /** Free-form tags — `--tag`, `/tag`. */
  tags?: string[];
  /** The session this one was branched from (`--fork-session`, `/branch`). */
  parent?: string;
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
  name?: string;
  tags?: string[];
  parent?: string;
};

const MAX_LABEL_CHARS = 64;

/**
 * A session label is one printable line of ≤64 chars, or null. It gets typed
 * back at `-r`, so anything a flag parser would eat again — leading `-`, a
 * control character, an embedded newline — is refused here instead of being
 * stored and rediscovered as a session nobody can resume.
 */
export function sanitizeSessionLabel(raw: string): string | null {
  const oneLine = raw.replace(/\s+/gu, " ").trim();
  if (oneLine.length === 0 || oneLine.length > MAX_LABEL_CHARS) return null;
  if (/^[-/!.]/u.test(oneLine)) return null;
  for (const ch of oneLine) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  return oneLine;
}

/**
 * A session *name* is the handle `-r` looks up, so it must survive being typed
 * back: one whitespace-free token of ≤64 chars. Tags may be phrases — they are
 * only ever displayed — but a name with a space in it renders as a resume
 * command that does not resume.
 */
export function sanitizeSessionName(raw: string): string | null {
  const token = raw.trim();
  if (/\s/u.test(token)) return null;
  return sanitizeSessionLabel(token);
}

/** The name rule in one place, so help text and every rejection say the same thing. */
export const SESSION_NAME_RULE = `a session name is one word of 1-${MAX_LABEL_CHARS} chars with no spaces, not starting with -, /, ! or .`;
/** Tags keep the looser one-line rule; they are display-only. */
export const SESSION_TAG_RULE = `a tag is one printable line of 1-${MAX_LABEL_CHARS} chars`;

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

function labelList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((t): t is string => typeof t === "string" && t.length > 0);
  return out.length === 0 ? undefined : out;
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
      ...(rec.lastRunId === undefined ? {} : { lastRunId: rec.lastRunId }),
      ...(rec.name === undefined ? {} : { name: rec.name }),
      ...(rec.tags === undefined || rec.tags.length === 0 ? {} : { tags: [...rec.tags] }),
      ...(rec.parent === undefined ? {} : { parent: rec.parent }),
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

/** Labels a session carries: what `-r` finds it by, and where it came from. */
export type SessionLabels = { name?: string; tags?: string[]; parent?: string };

/**
 * The record one run writes. `runId` in the file is the *session* id (the file
 * name, stable across resumes); `lastRunId` is the run that wrote it, which is
 * the id the audit chain knows.
 */
export function sessionRecord(f: {
  sessionId: string;
  runId: string;
  provider: string;
  model: string;
  messages: LoopMsg[];
  labels: SessionLabels;
}): SessionRecord {
  return {
    v: 1,
    ts: new Date().toISOString(),
    runId: f.sessionId,
    provider: f.provider,
    model: f.model,
    messages: f.messages,
    lastRunId: f.runId,
    ...(f.labels.name === undefined ? {} : { name: f.labels.name }),
    ...(f.labels.tags === undefined || f.labels.tags.length === 0 ? {} : { tags: [...f.labels.tags] }),
    ...(f.labels.parent === undefined ? {} : { parent: f.labels.parent }),
  };
}

/**
 * Which session file a run writes, and what its lineage is. A fresh run owns a
 * new id; a resumed run accumulates into the session it resumed (so `-r` the
 * same name keeps finding one growing transcript); `--fork-session` takes the
 * transcript but starts a new file that records where it came from.
 */
export function sessionIdentity(f: {
  currentRunId: string;
  resumedFrom?: string;
  fork: boolean;
}): { sessionId: string; parent?: string } {
  if (f.resumedFrom === undefined) return { sessionId: f.currentRunId };
  return f.fork
    ? { sessionId: f.currentRunId, parent: f.resumedFrom }
    : { sessionId: f.resumedFrom };
}

/** Resolve a reference to a session id: an exact name first, then a ≥4-char id prefix. */
export function resolveSession(cwd: string, prefix: string): string | null | "ambiguous" {
  if (prefix.length === 0) return null;
  const named = listSessions(cwd).filter((s) => s.name === prefix).map((s) => s.runId);
  if (named.length === 1) return named[0] as string;
  if (named.length > 1) return "ambiguous";
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

/** Load one session: bare = most recent; else that name or prefix. Never throws. */
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
    const resolved = resolveSession(cwd, prefix);
    if (resolved === "ambiguous") return { ok: false, error: `ambiguous reference "${prefix}" — use more of the id or rename one session (see: codewhip sessions)` };
    if (resolved === null) {
      // A corrupt file still owns its name: surface "corrupt" instead of a
      // misleading "no session" when the name matches but won't parse.
      if (prefix.length >= 4) {
        try {
          const names = fs.readdirSync(sessionDir(cwd));
          const hit = names.filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).find((id) => id === prefix || id.startsWith(prefix));
          if (hit !== undefined) return { ok: false, error: `session ${hit.slice(0, 8)} is corrupt (unreadable JSON) — start a fresh run` };
        } catch { /* fall through to the miss */ }
      }
      return { ok: false, error: `no session named or starting with "${prefix}" (see: codewhip sessions)` };
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

/** True when some other session already answers to this name. */
export function nameTaken(cwd: string, name: string, exceptRunId: string): boolean {
  return listSessions(cwd).some((s) => s.name === name && s.runId !== exceptRunId);
}

/**
 * Relabel one session in place (name, tags, parent). The transcript is
 * rewritten through the same redaction path as any save, so a rename can never
 * smuggle a secret back in.
 */
export function labelSession(
  cwd: string,
  ref: string,
  patch: { name?: string; addTag?: string; parent?: string },
): { ok: true; runId: string; name?: string } | { ok: false; error: string } {
  const loaded = loadSession(cwd, ref);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  const rec = loaded.record;
  let name: string | undefined;
  if (patch.name !== undefined) {
    const clean = sanitizeSessionName(patch.name);
    if (clean === null) return { ok: false, error: `${SESSION_NAME_RULE} (got "${patch.name}")` };
    name = clean;
    const taken = nameTaken(cwd, clean, rec.runId);
    if (taken) return { ok: false, error: `another session is already named "${clean}" — names resume by -r <name>, so they stay unique (see: codewhip sessions)` };
  }
  let addTag: string | undefined;
  if (patch.addTag !== undefined) {
    const clean = sanitizeSessionLabel(patch.addTag);
    if (clean === null) return { ok: false, error: `${SESSION_TAG_RULE} (got "${patch.addTag}")` };
    addTag = clean;
  }
  const next: SessionRecord = {
    v: 1,
    ts: rec.ts,
    runId: rec.runId,
    provider: rec.provider,
    model: rec.model,
    messages: rec.messages,
    ...(rec.lastRunId === undefined ? {} : { lastRunId: rec.lastRunId }),
    ...((name ?? rec.name) === undefined ? {} : { name: name ?? rec.name }),
    ...((patch.parent ?? rec.parent) === undefined ? {} : { parent: patch.parent ?? rec.parent }),
  };
  const tags = [...(rec.tags ?? [])];
  if (addTag !== undefined && !tags.includes(addTag)) tags.push(addTag);
  if (tags.length > 0) next.tags = tags;
  if (!saveSession(cwd, next)) return { ok: false, error: "session relabel failed (disk write)" };
  return { ok: true, runId: rec.runId, ...(next.name === undefined ? {} : { name: next.name }) };
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
      const name = typeof rec.name === "string" ? rec.name : undefined;
      const parent = typeof rec.parent === "string" ? rec.parent : undefined;
      out.push({
        runId: rec.runId,
        ts: typeof rec.ts === "string" ? rec.ts : "",
        provider: typeof rec.provider === "string" ? rec.provider : "",
        model: typeof rec.model === "string" ? rec.model : "",
        messages: (rec.messages as LoopMsg[]).length,
        preview: redactSecrets(firstUser?.content ?? "").slice(0, 60),
        mtimeMs: stat.mtimeMs,
        ...(name === undefined ? {} : { name }),
        ...(rec.tags === undefined ? {} : { tags: labelList(rec.tags) }),
        ...(parent === undefined ? {} : { parent }),
      });
    } catch { /* corrupt file: skip */ }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}
