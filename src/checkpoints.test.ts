import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { agentLoop } from "./loop.js";
import { makeFakePort, toolTurn, textTurn } from "./testkit/fakePort.js";
import { listRules } from "./remember-store.js";
import { verifyChain } from "./audit.js";
import {
  captureBefore,
  saveCheckpoint,
  readManifest,
  listCheckpointRuns,
  resolveCheckpointRun,
  rollbackRun,
} from "./checkpoints.js";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "codewhip-ckpt-"));
}
function stubAsk(): Promise<"yes" | "always" | "no"> {
  return Promise.resolve("yes");
}

describe("checkpoints", () => {
  it("captureBefore reads the target, refuses escapes and self-protected paths", () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.txt"), "original", "utf8");
    fs.mkdirSync(path.join(cwd, ".codewhip"));
    fs.writeFileSync(path.join(cwd, ".codewhip", "x"), "secret", "utf8");
    fs.writeFileSync(path.join(cwd, "codewhip-policy.yaml"), "deny:", "utf8");
    strictEqual(captureBefore(cwd, { path: "a.txt" })?.content, "original");
    strictEqual(captureBefore(cwd, { path: "missing.txt" })?.content, null);
    strictEqual(captureBefore(cwd, { path: ".codewhip/x" }), null);
    strictEqual(captureBefore(cwd, { path: "codewhip-policy.yaml" }), null);
    strictEqual(captureBefore(cwd, { path: "../outside.txt" }), null);
    strictEqual(captureBefore(cwd, { nope: true }), null);
    strictEqual(captureBefore(cwd, null), null);
  });
  it("saveCheckpoint + readManifest round-trips entries", () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.txt"), "original", "utf8");
    const cap = captureBefore(cwd, { path: "a.txt" }) as { rel: string; abs: string; content: string };
    fs.writeFileSync(cap.abs, "overwritten", "utf8");
    ok(saveCheckpoint(cwd, "run-1", 1, cap));
    const m = readManifest(cwd, "run-1");
    strictEqual(m.length, 1);
    strictEqual(m[0]?.seq, 1);
    strictEqual(m[0]?.file, "a.txt");
    strictEqual(m[0]?.existed, true);
  });
  it("loop snapshots every successful edit/write; rollback restores pre-run state", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "existing.txt"), "before-run", "utf8");
    const { port } = makeFakePort([
      toolTurn("write", JSON.stringify({ path: "created.txt", content: "brand new" })),
      toolTurn("edit", JSON.stringify({ path: "existing.txt", oldString: "before", newString: "after" })),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "mutate", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    strictEqual(r.text, "done");
    strictEqual(r.checkpoints, 2);
    strictEqual(fs.readFileSync(path.join(cwd, "created.txt"), "utf8"), "brand new");
    const m = readManifest(cwd, r.runId);
    strictEqual(m.length, 2);
    strictEqual(m[0]?.existed, false, "created.txt had no before-image");
    strictEqual(m[1]?.existed, true, "existing.txt was snapshotted");
    const undo = rollbackRun(cwd, r.runId);
    ok(undo.ok, JSON.stringify(undo));
    if (undo.ok) {
      strictEqual(undo.removed.join(","), "created.txt");
      strictEqual(undo.restored.join(","), "existing.txt");
    }
    ok(!fs.existsSync(path.join(cwd, "created.txt")));
    strictEqual(fs.readFileSync(path.join(cwd, "existing.txt"), "utf8"), "before-run");
    // A failed mutation leaves no checkpoint trail: only the 2 successes.
    strictEqual(listCheckpointRuns(cwd).find((x) => x.runId === r.runId)?.files, 2);
  });
  it("rollback refuses a tampered before-image before touching any file", async () => {
    const cwd = tmp();
    fs.writeFileSync(path.join(cwd, "a.txt"), "v1", "utf8");
    const { port } = makeFakePort([
      toolTurn("write", JSON.stringify({ path: "a.txt", content: "v2" })),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "mutate", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    strictEqual(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "v2");
    const m = readManifest(cwd, r.runId);
    strictEqual(m.length, 1);
    const dir = path.join(cwd, ".codewhip", "checkpoints", r.runId);
    fs.writeFileSync(path.join(dir, `${m[0]?.seq}.before`), "tampered", "utf8");
    const undo = rollbackRun(cwd, r.runId);
    ok(!undo.ok);
    if (!undo.ok) ok(undo.error.includes("hash mismatch"), undo.error);
    strictEqual(fs.readFileSync(path.join(cwd, "a.txt"), "utf8"), "v2", "file untouched on refusal");
  });
  it("prefix resolution is short-proof, unique, and ambiguous-aware", async () => {
    const cwd = tmp();
    strictEqual(resolveCheckpointRun(cwd, "abcd"), null);
    strictEqual(listCheckpointRuns(cwd).length, 0);
    const { port } = makeFakePort([
      toolTurn("write", JSON.stringify({ path: "f.txt", content: "x" })),
      textTurn("done"),
    ]);
    const r = await agentLoop({
      prompt: "mutate", model: "m", label: "nvidia", cwd, maxSteps: 5, yolo: true,
      stdinIsTTY: true, port, askUser: stubAsk, remembered: listRules(cwd),
    });
    strictEqual(resolveCheckpointRun(cwd, "ab"), null, "prefix must be >=4 chars");
    strictEqual(resolveCheckpointRun(cwd, r.runId.slice(0, 8)), r.runId);
    // Audit chain still intact with checkpointing active.
    strictEqual(verifyChain(cwd).valid, true);
  });
});
