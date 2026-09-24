import { describe, it, beforeEach } from "node:test";
import { strictEqual, ok, deepStrictEqual } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  labelSession,
  listSessions,
  loadSession,
  nameTaken,
  resolveSession,
  sanitizeSessionLabel,
  sanitizeSessionName,
  saveSession,
  sessionIdentity,
  sessionRecord,
  sessionDir,
} from "./sessions.js";
import { parseRunArgs, replSessionCommand, type ReplState } from "./index.js";
import { setWriteSink } from "./run-output.js";

/**
 * Wave-2 session naming (docs/moat/20-claude-code-parity.md): `-r` by name,
 * `--name`/`--tag`/`--fork-session`, and the REPL `.rename`/`.tag`/`.branch`.
 *
 * `cmdRun` is not driven here: it needs a real provider port. The composition it
 * does is one pure call (`sessionIdentity`) plus one store write, both covered
 * below, so the behaviour under test is the whole decision.
 */

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-naming-"));

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";

function parse(args: string[]): ReturnType<typeof parseRunArgs> {
  const before = process.exitCode;
  try {
    return parseRunArgs(args);
  } finally {
    setWriteSink(null);
    process.exitCode = before;
  }
}

const saved = (cwd: string, runId: string, over: { name?: string; tags?: string[] } = {}): void => {
  strictEqual(
    saveSession(cwd, sessionRecord({
      sessionId: runId,
      runId,
      provider: "nvidia",
      model: "m",
      messages: [{ role: "user", content: "prompt one" }],
      labels: over,
    })),
    true,
  );
};

describe("session naming flags", () => {
  it("-r and --resume are aliases for --continue, space and = forms", () => {
    for (const args of [["x", "-r", "abcd1111"], ["x", "--resume", "abcd1111"], ["x", "--continue", "abcd1111"], ["x", "-r=abcd1111"]] as const) {
      const o = parse([...args]);
      ok(o !== null, args.join(" "));
      strictEqual(o.continue, true, args.join(" "));
      strictEqual(o.continuePrefix, "abcd1111", args.join(" "));
    }
    const bare = parse(["x", "-r"]);
    ok(bare !== null);
    strictEqual(bare.continuePrefix, undefined, "bare -r is the most recent session");
  });

  it("--name and --tag parse, dedupe and validate", () => {
    const named = parse(["x", "-r", "--name", "auth", "--tag", "wip", "--tag=wip", "--tag", "today"]);
    ok(named !== null);
    strictEqual(named.sessionName, "auth");
    deepStrictEqual(named.sessionTags, ["wip", "today"]);

    for (const bad of [["x", "--name"], ["x", "--name="], ["x", "--name", "-r"], ["x", "--name", "--"], ["x", "--tag", ""]]) {
      strictEqual(parse(bad as string[]), null, `rejects ${bad.join(" ")}`);
    }
    // A name that would be eaten again as a flag is refused at parse time.
    strictEqual(parse(["x", "--name", "-o"] as string[]), null);
    strictEqual(parse(["x", "--name", "n".repeat(65)] as string[]), null);
    // A name is a lookup key, so it never carries a space.
    strictEqual(parse(["x", "--name", "two words"] as string[]), null);
    // Whitespace folds to one line rather than being rejected outright.
    const folded = parse(["x", "--tag", "a\nb"]);
    ok(folded !== null);
    deepStrictEqual(folded.sessionTags, ["a b"]);
  });

  it("--tag is capped at 8", () => {
    const args = ["x", ...Array.from({ length: 9 }, (_, i) => ["--tag", `t${i}`]).flat()];
    strictEqual(parse(args), null);
    const eight = ["x", ...Array.from({ length: 8 }, (_, i) => ["--tag", `t${i}`]).flat()];
    const o = parse(eight);
    ok(o !== null);
    strictEqual(o.sessionTags.length, 8);
  });

  it("--fork-session needs something to fork from", () => {
    strictEqual(parse(["x", "--fork-session"]), null);
    const o = parse(["x", "-r", "auth", "--fork-session"]);
    ok(o !== null);
    strictEqual(o.forkSession, true);
    strictEqual(o.continuePrefix, "auth");
  });

  it("naming a session arms persistence without resuming", () => {
    const o = parse(["x", "--name", "fresh"]);
    ok(o !== null);
    strictEqual(o.persist, true, "--name must actually write the transcript");
    strictEqual(o.continue, false, "…but it must not silently resume the most recent session");
    const plain = parse(["x"]);
    ok(plain !== null);
    strictEqual(plain.persist, false);
    strictEqual(plain.continue, false);
    const resumed = parse(["x", "-r"]);
    ok(resumed !== null);
    strictEqual(resumed.persist, true);
  });
});

describe("session store: names, identity, labels", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("sanitizeSessionLabel is one rule for CLI and store", () => {
    strictEqual(sanitizeSessionLabel("  auth  refactor  "), "auth refactor");
    strictEqual(sanitizeSessionLabel("a\tb"), "a b");
    for (const bad of ["", "   ", "-r", "/etc", "!bang", ".hidden", "x\u0000y", "n".repeat(65)]) {
      strictEqual(sanitizeSessionLabel(bad), null, `refuses "${bad}"`);
    }
  });

  it("a name is one word, a tag may be a phrase", () => {
    strictEqual(sanitizeSessionName("auth"), "auth");
    strictEqual(sanitizeSessionName("  auth  "), "auth", "surrounding space is trimmed, not part of the name");
    for (const bad of ["auth refactor", "a\tb", "", "-r", ".hidden", "n".repeat(65)]) {
      strictEqual(sanitizeSessionName(bad), null, `refuses "${bad}"`);
    }
    strictEqual(sanitizeSessionLabel("auth refactor"), "auth refactor");
  });

  it("nameTaken reports who already answers to a name", () => {
    saved(cwd, ID_A, { name: "auth" });
    strictEqual(nameTaken(cwd, "auth", ID_A), false, "a session may keep its own name");
    strictEqual(nameTaken(cwd, "auth", ID_B), true);
    strictEqual(nameTaken(cwd, "auth", ""), true, "a fork owns nothing, so any holder collides");
    strictEqual(nameTaken(cwd, "free", ID_B), false);
  });

  it("a name resolves before any id prefix, and -r <name> loads it", () => {
    saved(cwd, ID_A, { name: "auth" });
    saved(cwd, ID_B);
    strictEqual(resolveSession(cwd, "auth"), ID_A);
    const loaded = loadSession(cwd, "auth");
    ok(loaded.ok, JSON.stringify(loaded));
    if (loaded.ok) {
      strictEqual(loaded.record.runId, ID_A);
      strictEqual(loaded.record.name, "auth");
    }
    // Id prefixes still work, and a name beats a colliding prefix.
    strictEqual(resolveSession(cwd, ID_B.slice(0, 8)), ID_B);
  });

  it("listing carries name, tags and parent", () => {
    strictEqual(
      saveSession(cwd, sessionRecord({
        sessionId: ID_B,
        runId: ID_B,
        provider: "nvidia",
        model: "m",
        messages: [{ role: "user", content: "forked prompt" }],
        labels: { name: "auth-v2", tags: ["wip", "today"], parent: ID_A },
      })),
      true,
    );
    const row = listSessions(cwd)[0];
    ok(row !== undefined);
    strictEqual(row.name, "auth-v2");
    deepStrictEqual(row.tags, ["wip", "today"]);
    strictEqual(row.parent, ID_A);
  });

  it("labelSession renames and tags in place, keeping the transcript", () => {
    saved(cwd, ID_A);
    const renamed = labelSession(cwd, ID_A.slice(0, 8), { name: "auth" });
    ok(renamed.ok, JSON.stringify(renamed));
    strictEqual(renamed.ok && renamed.name, "auth");
    const tagged = labelSession(cwd, "auth", { addTag: "wip" });
    ok(tagged.ok, JSON.stringify(tagged));
    const loaded = loadSession(cwd, "auth");
    ok(loaded.ok);
    if (loaded.ok) {
      strictEqual(loaded.record.runId, ID_A);
      strictEqual(loaded.record.name, "auth");
      deepStrictEqual(loaded.record.tags, ["wip"]);
      strictEqual(loaded.record.messages.length, 1, "renaming never touches the transcript");
    }
    // Tags accumulate and names stay unique.
    ok(labelSession(cwd, "auth", { addTag: "wip" }).ok);
    deepStrictEqual(listSessions(cwd)[0]?.tags, ["wip"], "adding a tag twice is a no-op");
    saved(cwd, ID_B, { name: "taken" });
    const clash = labelSession(cwd, "auth", { name: "taken" });
    ok(!clash.ok && clash.error.includes("already named"), JSON.stringify(clash));
    ok(!labelSession(cwd, "auth", { name: "-r" }).ok);
    ok(!labelSession(cwd, "deadbeef", { name: "x" }).ok, "unknown reference");
  });

  it("sessionIdentity: fresh owns a new id, resume accumulates, fork records a parent", () => {
    deepStrictEqual(sessionIdentity({ currentRunId: ID_B, fork: false }), { sessionId: ID_B });
    deepStrictEqual(sessionIdentity({ currentRunId: ID_B, resumedFrom: ID_A, fork: false }), { sessionId: ID_A });
    deepStrictEqual(sessionIdentity({ currentRunId: ID_B, resumedFrom: ID_A, fork: true }), { sessionId: ID_B, parent: ID_A });
  });

  it("a resumed session keeps one growing file; a fork writes a second", () => {
    saved(cwd, ID_A, { name: "auth" });
    strictEqual(listSessions(cwd).length, 1);
    // Resume: identity says write back to ID_A.
    const runTwo = "cccccccc-0000-4000-8000-000000000003";
    const resumed = loadSession(cwd, "auth");
    ok(resumed.ok);
    if (!resumed.ok) return;
    const ident = sessionIdentity({ currentRunId: runTwo, resumedFrom: resumed.record.runId, fork: false });
    strictEqual(
      saveSession(cwd, sessionRecord({
        sessionId: ident.sessionId,
        runId: runTwo,
        provider: "nvidia",
        model: "m",
        messages: [...resumed.record.messages, { role: "user", content: "second" }],
        labels: { name: resumed.record.name },
      })),
      true,
    );
    const rows = listSessions(cwd);
    strictEqual(rows.length, 1, "resuming grows one transcript, it does not add a file");
    strictEqual(rows[0]?.runId, ID_A);
    strictEqual(rows[0]?.messages, 2);
    const afterResume = loadSession(cwd, "auth");
    ok(afterResume.ok && afterResume.record.lastRunId === runTwo, "the file records the run that wrote it");

    // Fork: identity says a new id with the parent recorded.
    const runThree = "dddddddd-0000-4000-8000-000000000004";
    const forked = sessionIdentity({ currentRunId: runThree, resumedFrom: ID_A, fork: true });
    strictEqual(
      saveSession(cwd, sessionRecord({
        sessionId: forked.sessionId,
        runId: runThree,
        provider: "nvidia",
        model: "m",
        messages: [...(afterResume.ok ? afterResume.record.messages : []), { role: "user", content: "third" }],
        labels: { tags: [], ...(forked.parent === undefined ? {} : { parent: forked.parent }) },
      })),
      true,
    );
    const afterFork = listSessions(cwd);
    strictEqual(afterFork.length, 2);
    const newFile = afterFork.find((r) => r.runId === runThree);
    ok(newFile !== undefined);
    strictEqual(newFile.parent, ID_A);
    strictEqual(newFile.name, undefined, "a fork does not steal its parent's name");
    strictEqual(fs.existsSync(path.join(sessionDir(cwd), `${ID_A}.json`)), true);
  });
});

const state = (over: Partial<ReplState> = {}): ReplState => ({
  history: [],
  provider: "nvidia",
  model: "m",
  lastRunId: null,
  sessionId: null,
  labels: { tags: [] },
  ...over,
});

const say = (cwd: string, s: ReplState, line: string): string => {
  const out = replSessionCommand(cwd, s, line);
  ok(out !== null, `${line} should be a session command`);
  return out.join(" | ");
};

describe("repl session commands", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = tmp();
  });

  it("non-session slashes fall through to custom commands", () => {
    for (const line of ["/help me", "/model gpt", "plain prompt", ".exit"]) {
      strictEqual(replSessionCommand(cwd, state(), line), null, line);
    }
  });

  it(".rename and .tag mutate the in-memory labels only", () => {
    const s = state({ sessionId: ID_A, lastRunId: ID_A });
    ok(say(cwd, s, ".rename auth").includes('"auth"'));
    strictEqual(s.labels.name, "auth");
    ok(say(cwd, s, ".tag wip").includes("#wip"));
    deepStrictEqual(s.labels.tags, ["wip"]);
    strictEqual(listSessions(cwd).length, 0, "the REPL writes nothing until .exit");
    ok(say(cwd, s, ".tag").includes("wip"));
    ok(say(cwd, s, ".rename").includes("usage:"));
    ok(say(cwd, s, ".rename -r").includes("rejected"));
    strictEqual(s.labels.name, "auth", "a rejected rename keeps the old name");
  });

  it("a name the REPL would collide with is refused before anything is written", () => {
    saved(cwd, ID_B, { name: "auth" });
    const s = state({ sessionId: ID_A, lastRunId: ID_A });
    ok(say(cwd, s, ".rename auth").includes("already named"));
    strictEqual(s.labels.name, undefined);
    ok(say(cwd, s, ".rename two words").includes("rejected"));
    ok(say(cwd, s, ".rename work").includes('"work"'));
    strictEqual(s.labels.name, "work", "a free name is accepted");
  });

  it(".branch forks the live transcript and keeps history", () => {
    const s = state({ sessionId: ID_A, lastRunId: ID_A, labels: { name: "auth", tags: ["wip"] } });
    ok(say(cwd, s, ".branch").includes(ID_A.slice(0, 8)));
    strictEqual(s.sessionId, null, "the next save must open a new file");
    strictEqual(s.labels.parent, ID_A);
    strictEqual(s.labels.name, "auth-branch", "a named session branches to a name that does not clash");
    deepStrictEqual(s.labels.tags, ["wip"]);
    ok(say(cwd, s, ".branch retry").includes("retry"));
    strictEqual(s.labels.name, "retry");
    strictEqual(s.labels.parent, ID_A, "branching twice still points at the same parent");
    ok(say(cwd, s, ".branch ../escape").includes("rejected"));
    const fresh = state();
    ok(say(cwd, fresh, ".branch").includes("nothing to fork"));
  });

  it(".branch refuses a name another session holds, and keeps the fork point", () => {
    saved(cwd, ID_B, { name: "auth" });
    const s = state({ sessionId: ID_A, lastRunId: ID_A, labels: { tags: [] } });
    ok(say(cwd, s, ".branch auth").includes("already named"));
    strictEqual(s.sessionId, ID_A, "a refused branch does not fork");
    strictEqual(s.labels.parent, undefined);
    ok(say(cwd, s, ".branch attempt-2").includes("attempt-2"));
    strictEqual(s.sessionId, null);
    strictEqual(s.labels.parent, ID_A);
  });

  it(".sessions lists what is on disk", () => {
    saved(cwd, ID_A, { name: "auth", tags: ["wip"] });
    const s = state();
    ok(say(cwd, s, ".sessions").includes(ID_A.slice(0, 8)));
    ok(say(cwd, s, ".sessions").includes("auth"));
    strictEqual(s.sessionId, null, "listing does not adopt the session it lists");
  });
});
