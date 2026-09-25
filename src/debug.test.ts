import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MAX_DEBUG_BYTES, openDebug, rejectDebugPath } from "./debug.js";
import { agentLoop } from "./loop.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { listRules } from "./remember-store.js";

function tmpFile(name = "run.log"): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-dbg-"));
  return { dir, file: path.join(dir, name) };
}

function collector(): { lines: string[]; to: (l: string) => void } {
  const lines: string[] = [];
  return { lines, to: (l): void => { lines.push(l); } };
}

describe("debug sink", () => {
  it("rejects an empty path and a newline in a path", () => {
    ok(rejectDebugPath("   ") !== null);
    ok(rejectDebugPath("a\nb.log") !== null);
  });

  it("refuses an env file: the log must not land on the secret-file shape", () => {
    ok(rejectDebugPath("prod.env")?.includes("env file"));
    ok(rejectDebugPath("nested/.env.local")?.includes("env file"));
    strictEqual(rejectDebugPath("nested/debug.log"), null);
  });

  it("refuses to land in .codewhip/, where the audit chain and keys live", () => {
    const bad = rejectDebugPath(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-")), ".codewhip", "x.log"));
    ok(bad !== null && bad.includes(".codewhip"));
  });

  it("streams to the caller's prose channel when no file is named", () => {
    const c = collector();
    const opened = openDebug({ to: c.to });
    strictEqual(opened.ok, true);
    if (!opened.ok) return;
    opened.debug("ladder write subject=\"src/a.ts\" verdict=ask:default");
    strictEqual(c.lines.length, 1);
    ok(c.lines[0]?.startsWith("[dbg "), c.lines[0]);
    ok(c.lines[0]?.includes("ladder write"), c.lines[0]);
    ok(opened.note.includes("stderr"), opened.note);
  });

  it("redacts a secret at the sink, so no call site can forget it", () => {
    const c = collector();
    const opened = openDebug({ to: c.to });
    strictEqual(opened.ok, true);
    if (!opened.ok) return;
    opened.debug(`authorization: Bearer sk-ant-api03-SUPERSECRETVALUE`);
    ok(!c.lines.join("\n").includes("SUPERSECRETVALUE"), c.lines.join("\n"));
  });

  it("folds a multi-line message into one clipped log line", () => {
    const c = collector();
    const opened = openDebug({ to: c.to });
    strictEqual(opened.ok, true);
    if (!opened.ok) return;
    opened.debug(`line one\nline two\n${"x".repeat(5000)}`);
    strictEqual(c.lines.length, 1);
    strictEqual(/\r?\n/.test(c.lines[0] ?? ""), false);
    ok(c.lines[0]!.includes("⏎"), c.lines[0]);
    ok(c.lines[0]!.endsWith("…[clipped]"), c.lines[0]!.slice(-20));
  });

  it("appends one file per open, and a second run continues the same log", () => {
    const { file } = tmpFile();
    const a = openDebug({ file, to: () => undefined });
    strictEqual(a.ok, true);
    if (!a.ok) return;
    a.debug("first run");
    const b = openDebug({ file, to: () => undefined });
    strictEqual(b.ok, true);
    if (!b.ok) return;
    b.debug("second run");
    const text = fs.readFileSync(file, "utf8");
    ok(text.includes("first run"), text);
    ok(text.includes("second run"), text);
    strictEqual(text.trimEnd().split("\n").filter((l) => l.length > 0).length, 2);
    ok(b.note.includes("appended"), b.note);
  });

  it("refuses a path whose directory does not exist", () => {
    const opened = openDebug({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cw-")), "nope", "x.log"), to: () => undefined });
    strictEqual(opened.ok, false);
    ok(!opened.ok && opened.error.includes("does not exist"), !opened.ok ? opened.error : "");
  });

  it("warns once when the sink breaks, then goes quiet and lets the run live", () => {
    const { dir } = tmpFile();
    // A directory as the target: the parent check passes, the write cannot.
    const c = collector();
    const opened = openDebug({ file: dir, to: c.to });
    strictEqual(opened.ok, true);
    if (!opened.ok) return;
    opened.debug("this cannot be written");
    opened.debug("nor can this one");
    strictEqual(c.lines.length, 1, c.lines.join("\n"));
    ok(c.lines[0]?.includes("diagnostics stop here, the run continues"), c.lines[0]);
  });

  it("stops at the cap instead of filling the disk", () => {
    strictEqual(MAX_DEBUG_BYTES, 8 * 1024 * 1024);
    const { file } = tmpFile("cap.log");
    const c = collector();
    const opened = openDebug({ file, to: c.to, maxBytes: 2000 });
    strictEqual(opened.ok, true);
    if (!opened.ok) return;
    for (let i = 0; i < 20; i += 1) opened.debug(`line ${i} ${"x".repeat(300)}`);
    const at = fs.statSync(file).size;
    ok(at <= 2000 && at > 2000 - 400, `stopped at ${at} of 2000`);
    const before = fs.readFileSync(file, "utf8");
    opened.debug("one past the cap");
    strictEqual(fs.readFileSync(file, "utf8"), before, "nothing lands past the cap");
    strictEqual(c.lines.length, 1);
    ok(c.lines[0]?.includes("byte cap"), c.lines[0]);
    ok(c.lines[0]?.includes("the run continues"), c.lines[0]);
  });
});

describe("debug in the loop", () => {
  it("stays silent unless armed, and records the decisions when it is", async () => {
    const runCwd = fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-loop-dbg-"));
    fs.writeFileSync(path.join(runCwd, "f.txt"), "hello\n");
    const quiet = await runDebugger(runCwd, false);
    strictEqual(quiet.length, 0, quiet.join("\n"));

    const loud = await runDebugger(runCwd, true);
    ok(loud.some((l) => l.startsWith("run ") && l.includes("mode=")), loud.join("\n"));
    ok(loud.some((l) => l.startsWith("step 1/")), loud.join("\n"));
    ok(loud.some((l) => l.startsWith("metered +")), loud.join("\n"));
    ok(loud.some((l) => l.startsWith('ladder read subject="f.txt" verdict=allow')), loud.join("\n"));
    ok(loud.some((l) => l.startsWith("exec read ")), loud.join("\n"));
    ok(loud.some((l) => l.startsWith("stop ")), loud.join("\n"));
  });
});

async function runDebugger(cwd: string, armed: boolean): Promise<string[]> {
  const lines: string[] = [];
  const { port } = makeFakePort([toolTurn("read", JSON.stringify({ path: "f.txt" })), textTurn("done")]);
  const r = await agentLoop({
    prompt: "read f", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
    stdinIsTTY: true, port, onEvent: () => undefined, remembered: listRules(cwd),
    ...(armed ? { debug: (msg: string): void => { lines.push(msg); } } : {}),
  });
  strictEqual(r.error, undefined);
  return lines;
}
