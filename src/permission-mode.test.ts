import { describe, it } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { loadSettings, parsePermissionMode, PERMISSION_MODES } from "./settings.js";
import type { PermissionMode } from "./settings.js";
import { jailPath, jailWritePath, resolveRoots, MAX_ROOTS } from "./tools/jail.js";
import { readTool } from "./tools/read.js";
import { writeTool } from "./tools/write.js";
import { rollbackRun } from "./checkpoints.js";
import { agentLoop } from "./loop.js";
import { readOutcomeRecords } from "./outcomes.js";
import type { ToolFilter } from "./tool-filter.js";
import { parseRunArgs as parseRunArgsRef } from "./index.js";
import { makeFakePort, textTurn, toolTurn } from "./testkit/fakePort.js";
import { listRules, persistRule } from "./remember-store.js";

/**
 * `--permission-mode`, `permissions.defaultMode` and `--add-dir`.
 *
 * The claim under test is a ladder position: a mode chooses WHO answers an
 * ask, never WHETHER a deny is answerable. So each test pins both halves —
 * what the mode lets through, and what still refuses in front of it. The jail
 * half pins the other invariant: extra roots buy containment only.
 */

function tempDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `codewhip-mode-${tag}-`));
}

/** A sibling of `cwd` — outside its jail unless added as a root. */
function outsideDir(tag: string): string {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `cw-${tag}-parent-`));
  return fs.mkdtempSync(path.join(parent, "outer-"));
}

function writeJson(file: string, doc: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
}

function withConfigDir<T>(dir: string, fn: () => T): T {
  const prior = process.env.CODEWHIP_CONFIG_DIR;
  process.env.CODEWHIP_CONFIG_DIR = dir;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.CODEWHIP_CONFIG_DIR;
    else process.env.CODEWHIP_CONFIG_DIR = prior;
  }
}

async function oneCall(
  runCwd: string,
  call: { name: string; args: unknown },
  opts: {
    mode?: PermissionMode;
    yolo?: boolean;
    plan?: boolean;
    roots?: readonly string[];
    allowed?: ToolFilter[];
    ask?: "yes" | "no";
  } = {}
): Promise<{ asks: number; trace: { policy: string; actor: string }[]; runId: string }> {
  const asks: string[] = [];
  const { port } = makeFakePort([toolTurn(call.name, JSON.stringify(call.args)), textTurn("done")]);
  const r = await agentLoop({
    prompt: "go", model: "m", label: "nvidia", cwd: runCwd, maxSteps: 5,
    yolo: opts.yolo ?? false, stdinIsTTY: true, port,
    askUser: async (q) => {
      asks.push(q);
      return opts.ask ?? "yes";
    },
    remembered: listRules(runCwd),
    ...(opts.mode === undefined ? {} : { permissionMode: opts.mode }),
    ...(opts.plan === undefined ? {} : { planMode: opts.plan }),
    ...(opts.roots === undefined ? {} : { roots: opts.roots }),
    ...(opts.allowed === undefined ? {} : { allowedTools: opts.allowed }),
    onEvent: () => undefined,
  });
  return { asks: asks.length, trace: r.trace.map((t) => ({ policy: t.policy, actor: t.actor })), runId: r.runId };
}

/** `parseRunArgs` sets exitCode on refusal — restore it, as headless-args does. */
function parse(args: string[]): ReturnType<typeof parseRunArgsRef> | null {
  const prior = process.exitCode;
  try {
    return parseRunArgsRef(args);
  } finally {
    process.exitCode = prior;
  }
}

describe("permission mode grammar", () => {
  it("accepts exactly the declared modes", () => {
    for (const m of PERMISSION_MODES) {
      strictEqual(parsePermissionMode(m), m);
    }
    strictEqual(PERMISSION_MODES.length, 6);
  });
  it("refuses anything else, including the mode the project has not built", () => {
    strictEqual(parsePermissionMode("auto"), null);
    strictEqual(parsePermissionMode("Default"), null);
    strictEqual(parsePermissionMode(""), null);
    strictEqual(parsePermissionMode(undefined), null);
    strictEqual(parsePermissionMode("acceptEdits "), null);
  });
});

describe("settings.json: the permissions block", () => {
  it("an absent file is not an error", () => {
    const dir = tempDir("absent");
    withConfigDir(tempDir("absent-cfg"), () => {
      const s = loadSettings(dir);
      strictEqual(s.defaultMode, undefined);
      deepStrictEqual(s.additionalDirs, []);
      deepStrictEqual(s.errors, []);
      deepStrictEqual(s.loaded, []);
    });
  });
  it("reads the global file, and the project file outranks it", () => {
    const cfg = tempDir("cfg");
    const dir = tempDir("proj");
    writeJson(path.join(cfg, "settings.json"), { permissions: { defaultMode: "acceptEdits" } });
    withConfigDir(cfg, () => {
      strictEqual(loadSettings(dir).defaultMode, "acceptEdits");
      writeJson(path.join(dir, ".codewhip", "settings.json"), { permissions: { defaultMode: "manual" } });
      const s = loadSettings(dir);
      strictEqual(s.defaultMode, "manual");
      strictEqual(s.loaded.length, 2, "both files reported, project last");
    });
  });
  it("an unknown mode is reported and ignored, never applied", () => {
    const cfg = tempDir("bad-cfg");
    const dir = tempDir("bad");
    writeJson(path.join(cfg, "settings.json"), { permissions: { defaultMode: "yolo-ish" } });
    withConfigDir(cfg, () => {
      const s = loadSettings(dir);
      strictEqual(s.defaultMode, undefined);
      strictEqual(s.errors.length, 1);
      ok(s.errors[0]?.includes("defaultMode"), s.errors.join("\n"));
    });
  });
  it("malformed JSON costs a line, not the run", () => {
    const cfg = tempDir("junk-cfg");
    const dir = tempDir("junk");
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, "settings.json"), "{ this is not json", "utf8");
    withConfigDir(cfg, () => {
      const s = loadSettings(dir);
      strictEqual(s.defaultMode, undefined);
      ok(s.errors.some((e) => e.includes("not valid JSON")), s.errors.join("\n"));
    });
  });
  it("directories concatenate across files, dedupe, and a non-array is reported", () => {
    const cfg = tempDir("dirs-cfg");
    const dir = tempDir("dirs");
    writeJson(path.join(cfg, "settings.json"), { permissions: { additionalDirectories: ["../a", "../b"] } });
    writeJson(path.join(dir, ".codewhip", "settings.json"), { permissions: { additionalDirectories: ["../b", "../c"] } });
    withConfigDir(cfg, () => {
      deepStrictEqual(loadSettings(dir).additionalDirs, ["../a", "../b", "../c"]);
    });
    writeJson(path.join(dir, ".codewhip", "settings.json"), { permissions: { additionalDirectories: "../a" } });
    withConfigDir(cfg, () => {
      const s = loadSettings(dir);
      ok(s.errors.some((e) => e.includes("not an array")), s.errors.join("\n"));
    });
  });
});

describe("jail: extra roots", () => {
  it("grounds relative entries and refuses ones that are not usable directories", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cw-roots-"));
    const cwd = path.join(work, "ws");
    const good = path.join(work, "good");
    fs.mkdirSync(cwd);
    fs.mkdirSync(good);
    const file = path.join(work, "afile.txt");
    fs.writeFileSync(file, "x", "utf8");
    const relative = path.relative(cwd, good);
    const r = resolveRoots([relative, path.join(work, "nope"), file, cwd, "notes"], cwd);
    strictEqual(r.roots.length, 1, r.errors.join("\n"));
    strictEqual(r.roots[0], fs.realpathSync(good), "resolved against the workspace, then realpath'd");
    ok(r.errors.some((e) => e.includes("no such directory")), r.errors.join("\n"));
    ok(r.errors.some((e) => e.includes("not a directory")), r.errors.join("\n"));
    ok(r.errors.some((e) => e.includes("already inside the workspace")), r.errors.join("\n"));
    fs.rmSync(work, { recursive: true, force: true });
  });
  it("caps the root list", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cw-cap-"));
    const cwd = path.join(work, "ws");
    fs.mkdirSync(cwd);
    const raw: string[] = [];
    for (let i = 0; i < MAX_ROOTS + 3; i += 1) {
      const d = path.join(work, `r${i}`);
      fs.mkdirSync(d);
      raw.push(d);
    }
    const r = resolveRoots(raw, cwd);
    strictEqual(r.roots.length, MAX_ROOTS);
    ok(r.errors.some((e) => e.includes("limit")), r.errors.join("\n"));
    fs.rmSync(work, { recursive: true, force: true });
  });
  it("a root admits its own files and nothing above them", () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "cw-adm-"));
    const cwd = path.join(work, "ws");
    const root = path.join(work, "root");
    const inner = path.join(root, "sub");
    fs.mkdirSync(cwd);
    fs.mkdirSync(inner, { recursive: true });
    const target = path.join(inner, "a.md");
    fs.writeFileSync(target, "hello\n", "utf8");
    const roots = resolveRoots([root], cwd).roots;
    strictEqual(jailPath(cwd, target, roots), fs.realpathSync(target));
    strictEqual(jailPath(cwd, target), null, "without the root it is still an escape");
    strictEqual(jailPath(cwd, path.join(root, "..", "outside.txt"), roots), null);
    ok(jailWritePath(cwd, path.join(root, "new", "deep.md"), roots) !== null, "write may create under a root");
    strictEqual(jailWritePath(cwd, path.join(root, "..", "escaped.md"), roots), null);
    fs.rmSync(work, { recursive: true, force: true });
  });
});

describe("file tools honour ctx.roots", () => {
  it("read reaches an added root, and only it", async () => {
    const cwd = tempDir("read-cwd");
    const root = outsideDir("read");
    const other = outsideDir("other");
    const target = path.join(root, "notes.md");
    fs.writeFileSync(target, "from the other directory\n", "utf8");
    const roots = resolveRoots([root], cwd).roots;
    const withRoots = await readTool({ cwd, roots }, { path: target });
    strictEqual(withRoots.ok, true, withRoots.output);
    ok(withRoots.output.includes("from the other directory"), withRoots.output);
    const withoutRoots = await readTool({ cwd }, { path: target });
    strictEqual(withoutRoots.ok, false);
    ok(/jail/.test(withoutRoots.output), withoutRoots.output);
    const neighbour = await readTool({ cwd, roots }, { path: path.join(other, "x.md") });
    strictEqual(neighbour.ok, false, "a root admits its own tree, not its sibling");
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
    fs.rmSync(path.dirname(other), { recursive: true, force: true });
  });
  it("write into a root still refuses harness state inside it", async () => {
    const cwd = tempDir("write-cwd");
    const root = outsideDir("write");
    fs.mkdirSync(path.join(root, ".codewhip"));
    const roots = resolveRoots([root], cwd).roots;
    const okWrite = await writeTool({ cwd, roots }, { path: path.join(root, "out.md"), content: "hi\n" });
    strictEqual(okWrite.ok, true, okWrite.output);
    ok(fs.existsSync(path.join(root, "out.md")));
    const stateWrite = await writeTool({ cwd, roots }, { path: path.join(root, ".codewhip", "key"), content: "hi\n" });
    strictEqual(stateWrite.ok, false);
    ok(/harness state/.test(stateWrite.output), stateWrite.output);
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });
});

describe("loop: a mode chooses who answers the ask", () => {
  it("acceptEdits self-answers an in-jail write, and audits it as a human grant", async () => {
    const cwd = tempDir("edits");
    const r = await oneCall(cwd, { name: "write", args: { path: "notes.md", content: "x\n" } }, { mode: "acceptEdits" });
    strictEqual(r.asks, 0, "no prompt");
    deepStrictEqual(r.trace, [{ policy: "allow:default:write:ask+mode:acceptEdits", actor: "human" }]);
    ok(fs.existsSync(path.join(cwd, "notes.md")));
  });
  it("acceptEdits leaves the shell and out-of-jail paths asking", async () => {
    const shell = await oneCall(tempDir("edits-bash"), { name: "bash", args: { command: "touch x" } }, {
      mode: "acceptEdits", ask: "no",
    });
    strictEqual(shell.asks, 1, "a shell yes is not scoped to one file");
    deepStrictEqual(shell.trace, [{ policy: "deny:default:shell:ask+declined", actor: "human" }]);

    const outside = outsideDir("edits-out");
    const o = await oneCall(tempDir("edits-out-run"), {
      name: "write", args: { path: path.join(outside, "escape.md"), content: "x\n" },
    }, { mode: "acceptEdits", ask: "no" });
    strictEqual(o.asks, 1, "a path in no root is not an edit inside the jail");
    strictEqual(fs.existsSync(path.join(outside, "escape.md")), false);
    fs.rmSync(path.dirname(outside), { recursive: true, force: true });
  });
  it("acceptEdits never answers for harness state, and does reach an added root", async () => {
    const cwd = tempDir("edits-self");
    fs.mkdirSync(path.join(cwd, ".codewhip"), { recursive: true });
    const self = await oneCall(cwd, { name: "write", args: { path: ".codewhip/key", content: "x\n" } }, {
      mode: "acceptEdits", ask: "no",
    });
    strictEqual(self.asks, 1, "a mode buys no authority over .codewhip/");

    const root = outsideDir("self-root");
    const widened = await oneCall(cwd, {
      name: "write", args: { path: path.join(root, "notes.md"), content: "x\n" },
    }, { mode: "acceptEdits", roots: resolveRoots([root], cwd).roots });
    strictEqual(widened.asks, 0, "an added root is part of the jail acceptEdits answers for");
    ok(fs.existsSync(path.join(root, "notes.md")));
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });
  it("dontAsk refuses an ungranted ask without ever prompting", async () => {
    const cwd = tempDir("dontask");
    const r = await oneCall(cwd, { name: "write", args: { path: "notes.md", content: "x\n" } }, { mode: "dontAsk" });
    strictEqual(r.asks, 0);
    deepStrictEqual(r.trace, [{ policy: "deny:default:write:ask+mode:dontAsk", actor: "policy" }]);
    strictEqual(fs.existsSync(path.join(cwd, "notes.md")), false);
  });
  it("dontAsk still allows what policy allows, and --allowed-tools still grants", async () => {
    const cwd = tempDir("dontask-ok");
    fs.writeFileSync(path.join(cwd, "f.txt"), "hello\n", "utf8");
    const read = await oneCall(cwd, { name: "read", args: { path: "f.txt" } }, { mode: "dontAsk" });
    deepStrictEqual(read.trace, [{ policy: "allow:default:read:allow", actor: "policy" }]);
    const granted = await oneCall(cwd, {
      name: "write", args: { path: "notes.md", content: "x\n" },
    }, { mode: "dontAsk", allowed: [{ tool: "write", shape: "notes.md" }] });
    deepStrictEqual(granted.trace, [{ policy: "allow:default:write:ask+allowed-tools", actor: "human" }]);
    ok(fs.existsSync(path.join(cwd, "notes.md")));
  });
  it("manual asks every time: --yolo, --allowed-tools and remembered rules pre-authorize nothing", async () => {
    const plain = await oneCall(tempDir("manual"), { name: "write", args: { path: "a.md", content: "x\n" } }, {
      mode: "manual",
    });
    deepStrictEqual(plain.trace, [{ policy: "allow:default:write:ask", actor: "human" }]);
    strictEqual(plain.asks, 1);

    const cwd = tempDir("manual2");
    persistRule(cwd, "run-seed", {
      tool: "write", shape: "b.md", ts: new Date().toISOString(), runId: "run-seed", preview_hash: "0".repeat(64),
    });
    const armed = await oneCall(cwd, { name: "write", args: { path: "b.md", content: "x\n" } }, {
      mode: "manual", yolo: true, allowed: [{ tool: "write", shape: "b.md" }],
    });
    strictEqual(armed.asks, 1, "manual is the operator insisting on the human");
    deepStrictEqual(armed.trace, [{ policy: "allow:default:write:ask", actor: "human" }]);
  });
  it("bypassPermissions answers the ask from the mode, and the ruleId says so", async () => {
    const cwd = tempDir("bypass");
    const r = await oneCall(cwd, { name: "write", args: { path: "notes.md", content: "x\n" } }, { mode: "bypassPermissions" });
    deepStrictEqual(r.trace, [{ policy: "allow:default:write:ask+mode:bypassPermissions", actor: "yolo" }]);
    ok(fs.existsSync(path.join(cwd, "notes.md")));
  });
  it("--yolo keeps its own audit spelling; the denylist outranks either", async () => {
    const flag = await oneCall(tempDir("yolo-flag"), { name: "write", args: { path: "n.md", content: "x\n" } }, { yolo: true });
    deepStrictEqual(flag.trace, [{ policy: "allow:default:write:ask+yolo", actor: "yolo" }]);
    const mode = await oneCall(tempDir("yolo-mode"), { name: "bash", args: { command: "rm -rf /" } }, { mode: "bypassPermissions" });
    strictEqual(mode.asks, 0);
    ok(mode.trace[0]?.policy.startsWith("deny:denylist:"), mode.trace[0]?.policy ?? "no trace");
  });
  it("plan stays structural: planMode is read-only whatever the mode says", async () => {
    const cwd = tempDir("plan");
    const r = await oneCall(cwd, { name: "write", args: { path: "notes.md", content: "x\n" } }, {
      mode: "acceptEdits", plan: true,
    });
    strictEqual(r.asks, 0);
    deepStrictEqual(r.trace, [{ policy: "deny:plan:read-only", actor: "policy" }]);
    strictEqual(fs.existsSync(path.join(cwd, "notes.md")), false);
  });
  it("the outcome record carries the mode it ran under", async () => {
    const cwd = tempDir("outcome");
    const { port } = makeFakePort([textTurn("done")]);
    await agentLoop({
      prompt: "go", model: "m", label: "nvidia", cwd, maxSteps: 3, yolo: false,
      stdinIsTTY: false, port, remembered: listRules(cwd), permissionMode: "dontAsk",
    });
    const recs = readOutcomeRecords(cwd);
    strictEqual(recs.length, 1);
    strictEqual(recs[0]?.permission_mode, "dontAsk");
    strictEqual(recs[0]?.yolo, false);
  });
});

describe("--add-dir end to end through the loop", () => {
  it("a write into an added root lands there, is checkpointed, and rolls back", async () => {
    const cwd = tempDir("e2e-cwd");
    const root = outsideDir("e2e");
    const roots = resolveRoots([root], cwd).roots;
    const target = path.join(root, "made.md");
    const r = await oneCall(cwd, { name: "write", args: { path: target, content: "created by the run\n" } }, {
      mode: "acceptEdits", roots,
    });
    deepStrictEqual(r.trace, [{ policy: "allow:default:write:ask+mode:acceptEdits", actor: "human" }]);
    ok(fs.existsSync(target), "the file landed in the added directory");
    const back = rollbackRun(cwd, r.runId);
    strictEqual(back.ok, true, back.ok ? "" : back.error);
    strictEqual(fs.existsSync(target), false, "undo covers --add-dir targets");
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });
  it("without the root the same call is a jail escape, not an accepted edit", async () => {
    const root = outsideDir("e2e2");
    const r = await oneCall(tempDir("e2e2-cwd"), {
      name: "write", args: { path: path.join(root, "made.md"), content: "x\n" },
    }, { mode: "acceptEdits", ask: "no" });
    strictEqual(r.asks, 1);
    strictEqual(fs.existsSync(path.join(root, "made.md")), false);
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });
});

describe("CLI: mode and root flags", () => {
  it("parses --permission-mode in both spellings", () => {
    strictEqual(parse(["--permission-mode", "acceptEdits", "go"])?.permissionMode, "acceptEdits");
    strictEqual(parse(["--permission-mode=dontAsk", "go"])?.permissionMode, "dontAsk");
    strictEqual(parse(["go"])?.permissionMode, undefined);
  });
  it("refuses an unknown mode and a repeated contradictory one", () => {
    strictEqual(parse(["--permission-mode", "autopilot", "go"]), null);
    strictEqual(parse(["--permission-mode", "manual", "--permission-mode", "default", "go"]), null);
    ok(parse(["--permission-mode", "manual", "--permission-mode", "manual", "go"]) !== null);
  });
  it("refuses a mode that contradicts its own shorthand, allows the matching one", () => {
    strictEqual(parse(["--plan", "--permission-mode", "acceptEdits", "go"]), null);
    strictEqual(parse(["--yolo", "--permission-mode", "manual", "go"]), null);
    ok(parse(["--plan", "--permission-mode", "plan", "go"]) !== null);
    ok(parse(["--yolo", "--permission-mode", "bypassPermissions", "go"]) !== null);
    strictEqual(parse(["--plan", "go"])?.permissionMode, undefined, "a shorthand is not a mode");
  });
  it("accumulates --add-dir and caps it", () => {
    const o = parse(["--add-dir", "a", "--add-dir=b", "go"]);
    ok(o !== null);
    deepStrictEqual(o.addDirs, ["a", "b"]);
    const many = Array.from({ length: MAX_ROOTS + 1 }, (_, i) => `--add-dir=d${i}`);
    strictEqual(parse([...many, "go"]), null);
    strictEqual(parse([...Array.from({ length: MAX_ROOTS }, (_, i) => `--add-dir=d${i}`), "go"])?.addDirs.length, MAX_ROOTS);
  });
});
