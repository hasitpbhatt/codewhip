import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listSessions,
  loadSession,
  resolveSession,
  saveSession,
  sessionDir,
  type SessionRecord,
} from "./sessions.js";
import { buildShareBundle } from "./share.js";
import { agentLoop } from "./loop.js";
import { makeFakePort, textTurn } from "./testkit/fakePort.js";
import { parseRunArgs } from "./index.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-sessions-"));

const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  v: 1,
  ts: new Date().toISOString(),
  runId: "11111111-2222-4333-8444-555555555555",
  provider: "nvidia",
  model: "m",
  messages: [
    { role: "user", content: "first prompt here" },
    { role: "assistant", content: "answer one" },
    { role: "user", content: "second prompt" },
  ],
  ...over,
});

describe("sessions", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("no session dir → clean empty list (never throws)", () => {
    strictEqual(fs.existsSync(sessionDir(cwd)), false);
    strictEqual(listSessions(cwd).length, 0);
    strictEqual(resolveSession(cwd, "abcd"), null);
  });

  it("save/load round-trip preserves the transcript (system stripped)", () => {
    const r = rec({
      messages: [
        { role: "system", content: "sys — rebuilt fresh, never stored" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
    });
    strictEqual(saveSession(cwd, r), true);
    const loaded = loadSession(cwd, r.runId.slice(0, 8));
    ok(loaded.ok, JSON.stringify(loaded));
    if (loaded.ok) {
      strictEqual(loaded.record.runId, r.runId);
      ok(loaded.record.messages.every((m) => m.role !== "system"));
      strictEqual(loaded.record.messages.length, 2);
    }
  });

  it("bare load returns the most recent session", () => {
    const a = rec({ runId: "aaaaaaaa-0000-4000-8000-000000000001" });
    strictEqual(saveSession(cwd, a), true);
    fs.utimesSync(path.join(sessionDir(cwd), `${a.runId}.json`), new Date(1000), new Date(1000));
    const b = rec({ runId: "bbbbbbbb-0000-4000-8000-000000000002" });
    strictEqual(saveSession(cwd, b), true);
    fs.utimesSync(path.join(sessionDir(cwd), `${b.runId}.json`), new Date(2000), new Date(2000));
    const loaded = loadSession(cwd);
    ok(loaded.ok);
    if (loaded.ok) strictEqual(loaded.record.runId, b.runId);
  });

  it("prefix resolve needs >=4 chars and uniqueness", () => {
    strictEqual(saveSession(cwd, rec({ runId: "abcd1111-0000-4000-8000-000000000001" })), true);
    strictEqual(saveSession(cwd, rec({ runId: "abcd2222-0000-4000-8000-000000000002" })), true);
    // Too short: clean miss, no throw.
    strictEqual(resolveSession(cwd, "abc"), null);
    const short = loadSession(cwd, "abc");
    ok(!short.ok);
    // Shared 4-char prefix: ambiguous.
    strictEqual(resolveSession(cwd, "abcd"), "ambiguous");
    const amb = loadSession(cwd, "abcd");
    ok(!amb.ok && amb.error.includes("ambiguous"));
    // Unique 8-char prefix resolves.
    strictEqual(resolveSession(cwd, "abcd1111"), "abcd1111-0000-4000-8000-000000000001");
    // Unknown prefix: clean miss, and no file was created for it.
    const miss = loadSession(cwd, "deadbeef");
    ok(!miss.ok && miss.error.includes("no session"));
    strictEqual(listSessions(cwd).length, 2);
  });

  it("listing is newest-mtime first with redacted 60-char previews", () => {
    const old = rec({ runId: "aaaaaaaa-0000-4000-8000-000000000001", messages: [{ role: "user", content: "old prompt" }] });
    const young = rec({ runId: "bbbbbbbb-0000-4000-8000-000000000002", messages: [{ role: "user", content: "young prompt " + "x".repeat(100) }] });
    strictEqual(saveSession(cwd, old), true);
    fs.utimesSync(path.join(sessionDir(cwd), `${old.runId}.json`), new Date(1000), new Date(1000));
    strictEqual(saveSession(cwd, young), true);
    fs.utimesSync(path.join(sessionDir(cwd), `${young.runId}.json`), new Date(5000), new Date(5000));
    const rows = listSessions(cwd);
    strictEqual(rows.length, 2);
    strictEqual(rows[0]?.runId, young.runId);
    strictEqual(rows[1]?.runId, old.runId);
    ok((rows[0]?.preview.length ?? 99) <= 60);
    ok(rows[0]?.preview.startsWith("young prompt") === true);
  });

  it("secrets are redacted at write time (raw prompts otherwise kept)", () => {
    const secret = "fix it with sk-abcDEF123xyz and admin@example.com";
    strictEqual(saveSession(cwd, rec({ messages: [{ role: "user", content: secret }] })), true);
    const raw = fs.readFileSync(path.join(sessionDir(cwd), "11111111-2222-4333-8444-555555555555.json"), "utf8");
    ok(!raw.includes("sk-abcDEF123xyz"), raw);
    ok(!raw.includes("admin@example.com"), raw);
    ok(raw.includes("first prompt here") === false); // this record overwrote with `secret`
    ok(raw.includes("[redacted]"), raw);
    // Ordinary text survives redaction untouched.
    strictEqual(saveSession(cwd, rec({ runId: "cccccccc-0000-4000-8000-000000000003", messages: [{ role: "user", content: "migrate auth to sessions" }] })), true);
    const plain = fs.readFileSync(path.join(sessionDir(cwd), "cccccccc-0000-4000-8000-000000000003.json"), "utf8");
    ok(plain.includes("migrate auth to sessions"), plain);
  });

  it("corrupt files are skipped by list, error by load (never throw)", () => {
    fs.mkdirSync(sessionDir(cwd), { recursive: true });
    fs.writeFileSync(path.join(sessionDir(cwd), "zzzzzzzz.json"), "{ not json", "utf8");
    strictEqual(listSessions(cwd).length, 0);
    const loaded = loadSession(cwd, "zzzzzzzz");
    ok(!loaded.ok && loaded.error.includes("corrupt"));
  });

  it("session files live under .codewhip/sessions with tight perms", () => {
    strictEqual(saveSession(cwd, rec()), true);
    const p = path.join(sessionDir(cwd), "11111111-2222-4333-8444-555555555555.json");
    ok(fs.existsSync(p));
    if (process.platform !== "win32") {
      strictEqual(fs.statSync(p).mode & 0o777, 0o600);
      strictEqual(fs.statSync(sessionDir(cwd)).mode & 0o777, 0o700);
    }
  });

  it("agentLoop alone never writes a session file (opt-in only)", async () => {
    const { port } = makeFakePort([textTurn("done")]);
    const r = await agentLoop({
      prompt: "hello raw prompt", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port,
    });
    strictEqual(r.text, "done");
    strictEqual(fs.existsSync(sessionDir(cwd)), false);
  });

  it("share bundles never sweep session files in", () => {
    const marker = "session-marker-UNIQUE-93247";
    strictEqual(saveSession(cwd, rec({ messages: [{ role: "user", content: marker }] })), true);
    const { bundle, json } = buildShareBundle(cwd, {
      runId: "r-share-1",
      model: "nvidia:m",
      prompt: "share me",
      resultText: "done",
      trace: [],
      promptTokens: 1,
      completionTokens: 1,
      usageByModel: [],
      receipt: "receipt",
    });
    ok(!json.includes(marker), json);
    ok(!JSON.stringify(bundle).includes("sessions/"), JSON.stringify(bundle));
  });

  it("--continue parses bare, with prefix, and with =prefix", () => {
    const bare = parseRunArgs(["hello", "--continue"]);
    ok(bare !== null && bare.continue === true && bare.continuePrefix === undefined);
    strictEqual(bare.prompt, "hello");
    const prefixed = parseRunArgs(["hello", "--continue", "37b0abcd"]);
    ok(prefixed !== null && prefixed.continue === true && prefixed.continuePrefix === "37b0abcd");
    strictEqual(prefixed.prompt, "hello");
    const eq = parseRunArgs(["hello", "--continue=37b0abcd"]);
    ok(eq !== null && eq.continue === true && eq.continuePrefix === "37b0abcd");
    const noFlag = parseRunArgs(["hello"]);
    ok(noFlag !== null && noFlag.continue === false);
  });

  it("--continue with unknown prefix: clean error, no partial write", () => {
    // Mirrors cmdRun's failure contract: load fails → exit 1 + stub receipt,
    // and no session file is created for the unknown prefix.
    const before = listSessions(cwd);
    strictEqual(before.length, 0);
    const loaded = loadSession(cwd, "deadbeef");
    ok(!loaded.ok);
    strictEqual(listSessions(cwd).length, 0);
    strictEqual(fs.existsSync(path.join(sessionDir(cwd), "deadbeef.json")), false);
  });
});
