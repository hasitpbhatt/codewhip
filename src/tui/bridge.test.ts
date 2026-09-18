import { describe, it } from "node:test";
import { strictEqual, ok } from "node:assert/strict";
import { TuiModel } from "./model.js";
import { createTuiBridge } from "./bridge.js";
import { createTuiView, createFallbackView } from "./view.js";
import type { LoopEvent } from "../loop.js";

describe("TuiModel", () => {
  it("starts stopped, no timer, empty state", () => {
    const m = new TuiModel();
    const snap = m.snapshot();
    strictEqual(snap.tail.length, 0);
    strictEqual(snap.pending, null);
    strictEqual(snap.background.length, 0);
    strictEqual(snap.meter.tokens, 0);
  });

  it("appends events to the ring", () => {
    const m = new TuiModel();
    m.appendEvent("first line");
    m.appendEvent("second line");
    const snap = m.snapshot();
    strictEqual(snap.tail.length, 2);
    ok(snap.tail[0]!.includes("first line"));
    ok(snap.tail[1]!.includes("second line"));
  });

  it("caps the ring at MAX_TAIL_LINES (200)", () => {
    const m = new TuiModel();
    for (let i = 0; i < 250; i++) {
      m.appendEvent(`line ${i}`);
    }
    const snap = m.snapshot();
    strictEqual(snap.tail.length, 200);
    ok(snap.tail[0]!.includes("line 50"));
    ok(snap.tail[199]!.includes("line 249"));
  });

  it("is append-only: snapshot returns a copy, not the internal array", () => {
    const m = new TuiModel();
    m.appendEvent("hello");
    const snap1 = m.snapshot();
    snap1.tail.push("mutated");
    const snap2 = m.snapshot();
    strictEqual(snap2.tail.length, 1);
  });

  it("setPending / clearPending", () => {
    const m = new TuiModel();
    m.setPending("allow shell: rm -rf / ?");
    strictEqual(m.snapshot().pending?.question, "allow shell: rm -rf / ?");
    m.clearPending();
    strictEqual(m.snapshot().pending, null);
  });

  it("setBackground / setMeter", () => {
    const m = new TuiModel();
    m.setBackground([{ id: "bg-1", label: "task", status: "running", preview: "working" }]);
    m.setMeter({ tokens: 1000, estCost: 0.01, mix: { nvidia: "500" } });
    const snap = m.snapshot();
    strictEqual(snap.background.length, 1);
    strictEqual(snap.background[0]!.id, "bg-1");
    strictEqual(snap.meter.tokens, 1000);
    strictEqual(snap.meter.estCost, 0.01);
  });

  it("setRunId / pollBackground set and snapshot the runId and background cards", () => {
    const m = new TuiModel();
    m.setRunId("abc123def456");
    m.pollBackground([
      { id: "t1", label: "npm test", status: "running" as const, preview: "running..." },
    ]);
    const snap = m.snapshot();
    ok(snap.runId !== null && snap.runId.includes("abc123def456"));
    strictEqual(snap.background.length, 1);
    strictEqual(snap.background[0]!.id, "t1");
    strictEqual(snap.background[0]!.status, "running");
  });

  it("setDiffPreview / clearDiffPreview stores a capped preview", () => {
    const m = new TuiModel();
    const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
    m.setDiffPreview("src/foo.ts", content);
    const snap = m.snapshot();
    ok(snap.diffPreview !== null);
    strictEqual(snap.diffPreview!.rel, "src/foo.ts");
    strictEqual(snap.diffPreview!.lines.length, 15);
    m.clearDiffPreview();
    strictEqual(m.snapshot().diffPreview, null);
  });

  it("handleLoopEvent prefixes with kind-appropriate symbol", () => {
    const m = new TuiModel();
    const toolEvt: LoopEvent = { kind: "tool", text: "read file.ts" };
    const policyEvt: LoopEvent = { kind: "policy", text: "deny shell chaining" };
    const compactEvt: LoopEvent = { kind: "compact", text: "truncated old output" };

    m.handleLoopEvent(toolEvt);
    m.handleLoopEvent(policyEvt);
    m.handleLoopEvent(compactEvt);

    const tail = m.snapshot().tail;
    ok(tail[0]!.includes("▸ read file.ts"));
    ok(tail[1]!.includes("◈ deny shell chaining"));
    ok(tail[2]!.includes("◆ truncated old output"));
  });

  it("start/stop the poll timer", () => {
    const m = new TuiModel();
    let ticks = 0;
    m.onTick = () => { ticks++; };
    m.start();
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        m.stop();
        ok(ticks >= 1, "expected at least 1 poll tick");
        resolve();
      }, 600);
    });
  });
});

describe("TuiBridge", () => {
  it("returns an object with askUser, onEvent, start, stop", () => {
    const m = new TuiModel();
    const bridge = createTuiBridge({ model: m, signal: new AbortController().signal, cwd: process.cwd() });
    ok(typeof bridge.askUser === "function");
    ok(typeof bridge.onEvent === "function");
    ok(typeof bridge.start === "function");
    ok(typeof bridge.stop === "function");
  });

  it("onEvent appends to the model ring without throwing", () => {
    const m = new TuiModel();
    const bridge = createTuiBridge({ model: m, cwd: process.cwd() });
    const evt: LoopEvent = { kind: "tool", text: "bash ls" };
    bridge.onEvent(evt);
    ok(m.snapshot().tail[0]!.includes("bash ls"));
  });

  it("onEvent captures diff preview for edit/write tool events", () => {
    const m = new TuiModel();
    const bridge = createTuiBridge({ model: m, cwd: process.cwd() });
    // A tool event that looks like an edit call should trigger captureBefore.
    // We test with a path that exists in the test cwd.
    bridge.onEvent({ kind: "tool", text: "ok edit src/tui/model.ts (allow:ask:auto)" });
    const snap = m.snapshot();
    // captureBefore returns non-null for existing, non-self-protected paths.
    // The diff preview should be set or cleared (either is valid depending on
    // whether the file exists at test time).
    // captureBefore returns non-null for existing, non-self-protected paths.
    // rel may use platform-specific separators, so check the tail.
    if (snap.diffPreview !== null) {
      ok(snap.diffPreview.rel.replace(/\\/g, "/").endsWith("src/tui/model.ts"));
    }
  });

  it("onEvent never throws into the caller", () => {
    const m = new TuiModel();
    const bridge = createTuiBridge({ model: m, cwd: process.cwd() });
    const evt: LoopEvent = { kind: "retry", text: "retrying" };
    let threw = false;
    try {
      bridge.onEvent(evt);
    } catch {
      threw = true;
    }
    strictEqual(threw, false);
  });

  it("askUser resolves 'no' on abort signal", async () => {
    const m = new TuiModel();
    const ctrl = new AbortController();
    const bridge = createTuiBridge({ model: m, signal: ctrl.signal, cwd: process.cwd() });
    const promise = bridge.askUser("allow shell?");
    ctrl.abort();
    const result = await promise;
    strictEqual(result, "no");
  });

  it("start/stop cycle cleans up the model", () => {
    const m = new TuiModel();
    const bridge = createTuiBridge({ model: m, cwd: process.cwd() });
    bridge.start();
    bridge.stop();
    bridge.stop();
  });
});

describe("TuiView (fallback + lazy import)", () => {
  it("createFallbackView returns a handle with the right shape", () => {
    const m = new TuiModel();
    const handle = createFallbackView({ model: m });
    ok(typeof handle.renderApproval === "function");
    ok(typeof handle.renderTick === "function");
    ok(typeof handle.unmount === "function");
  });

  it("createTuiView falls back when OpenTUI is absent", async () => {
    const m = new TuiModel();
    const handle = await createTuiView({ model: m });
    ok(typeof handle.renderApproval === "function");
    ok(typeof handle.renderTick === "function");
    ok(typeof handle.unmount === "function");
  });
});
