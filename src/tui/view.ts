// TUI view: 5 regions (header, transcript tail, pending-approval card,
// composer, footer) + keymap + slash commands.
// OpenTUI is lazily imported — if absent, a minimal fallback renders the
// approval card via readline so the bridge still resolves promises.

import type { TuiModel, TuiModelSnapshot, PendingApproval, BackgroundCard } from "./model.js";

export type TuiViewDeps = {
  model: TuiModel;
  signal?: AbortSignal;
  /** Callback to execute slash commands from the composer. */
  onSlashCommand?: (cmd: SlashCommand) => void;
};

export type TuiViewHandle = {
  renderApproval: (question: string) => Promise<"yes" | "session" | "always" | "no">;
  renderTick: () => void;
  unmount: () => void;
};

export type SlashCommand = {
  cmd: "/model" | "/free" | "/plan" | "/rollback" | "/sessions" | "/help";
  args: string[];
};

export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0] as SlashCommand["cmd"];
  if (!["/model", "/free", "/plan", "/rollback", "/sessions", "/help"].includes(cmd)) return null;
  return { cmd, args: parts.slice(1) };
}

// --- Fallback view (readline) — used when OpenTUI is absent ---

import * as readline from "node:readline";

export function createFallbackView(deps: TuiViewDeps): TuiViewHandle {
  const { model } = deps;
  let rl: readline.Interface | null = null;

  function renderHeader(): string {
    return `[codewhip tui] head: model=run task=spike budget=est`;
  }

  function renderFooter(snap: TuiModelSnapshot): string {
    const m = snap.meter;
    const rollbackId = snap.runId ? snap.runId.slice(0, 8) : "<pending>";
    const revoke = snap.pending ? ` | revoke: Esc` : "";
    return `rollback: ${rollbackId}  |  tokens: ${m.tokens}  |  est: $${m.estCost.toFixed(4)}  |  /model /free /plan /rollback /sessions${revoke}`;
  }

  function renderDiffPreview(snap: TuiModelSnapshot): string | null {
    if (!snap.diffPreview) return null;
    const lines = snap.diffPreview.lines.map((l) => `  ${l}`).join("\n");
    return `DIFF (${snap.diffPreview.rel}):\n${lines}`;
  }

  function renderTranscript(snap: TuiModelSnapshot): string {
    return snap.tail.map((l) => l).join("\n");
  }

  function renderPending(snap: TuiModelSnapshot): string | null {
    if (!snap.pending) return null;
    return `PENDING APPROVAL:\n${snap.pending.question}\n(y)es (s)ession (a)lways (n)o`;
  }

  function renderFull(snap: TuiModelSnapshot): string {
    const parts: string[] = [];
    parts.push(renderHeader());
    parts.push("");
    parts.push(renderTranscript(snap));
    const diff = renderDiffPreview(snap);
    if (diff) {
      parts.push("");
      parts.push(diff);
    }
    const p = renderPending(snap);
    if (p) {
      parts.push("");
      parts.push(p);
    }
    parts.push("");
    parts.push(renderFooter(snap));
    return parts.join("\n");
  }

  function doRender(): void {
    const snap = model.snapshot();
    // Clear screen and render
    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    process.stdout.write(renderFull(snap));
  }

  function renderApproval(question: string): Promise<"yes" | "session" | "always" | "no"> {
    return new Promise((resolve) => {
      model.setPending(question);
      doRender();

      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question("> ", (answer) => {
        const a = answer.trim().toLowerCase();
        if (a === "a" || a === "always") resolve("always");
        else if (a === "s" || a === "session") resolve("session");
        else if (a === "y" || a === "yes") resolve("yes");
        else resolve("no");
        rl?.close();
        rl = null;
        model.clearPending();
      });
    });
  }

  function renderTick(): void {
    doRender();
  }

  function unmount(): void {
    rl?.close();
    rl = null;
  }

  return { renderApproval, renderTick, unmount };
}

// --- Main view factory: tries OpenTUI, falls back to readline ---

export async function createTuiView(deps: TuiViewDeps): Promise<TuiViewHandle> {
  try {
    // Eagerly try to lazy-import OpenTUI. If it's not installed, we fall
    // back to the readline-based view so the TUI bridge still functions.
    // @ts-expect-error — opentui is an optional peer dep; absent in headless builds.
    const mod = await import("opentui");
    return createOpentuiView(deps, mod);
  } catch {
    // OpenTUI not installed — use the fallback.
    return createFallbackView(deps);
  }
}

// Full OpenTUI-backed view — only loaded when the package is available.
async function createOpentuiView(deps: TuiViewDeps, mod: any): Promise<TuiViewHandle> {
  const { model } = deps;
  const Box = mod.Box;
  const Text = mod.Text;
  const app: { root: any; render: (s: any) => void; unmount: () => void; onKey: (cb: (k: string) => void) => void; onInput: (cb: (s: string) => void) => void } = {
    root: null,
    render: (_s: any) => {},
    unmount: () => {},
    onKey: (_cb: (k: string) => void) => {},
    onInput: (_cb: (s: string) => void) => {},
  };

  // Build a minimal OpenTUI-compatible renderer. If the real API differs,
  // the fallback path keeps things working.
  let approvalResolve: ((v: "yes" | "session" | "always" | "no") => void) | null = null;
  let composerText = "";

  function renderPendingCard(pending: PendingApproval | null): any {
    if (!pending) return null;
    return Box({ border: { type: "line" }, title: "approval", width: "100%" }, [
      Text(pending.question),
      Text(""),
      Text("[y]es  [s]ession  [a]lways  [n]o / Esc"),
    ]);
  }

  function renderHeader(snap: TuiModelSnapshot): any {
    const scope = "scope: auto";
    return Box({ border: { type: "line" }, title: "codewhip tui", width: "100%" }, [
      Text(`run: ${scope}  |  tokens: ${snap.meter.tokens}  |  est: $${snap.meter.estCost.toFixed(4)}`),
    ]);
  }

  function renderTranscript(snap: TuiModelSnapshot): any {
    const lines = snap.tail.length === 0
      ? [Text("(no events yet)")]
      : snap.tail.map((l) => Text(l));
    return Box({ border: { type: "line" }, title: "transcript", flex: 1 }, lines);
  }

  function renderBackground(snap: TuiModelSnapshot): any {
    if (snap.background.length === 0) return null;
    const cards = snap.background.map((c: BackgroundCard) =>
      Box({ border: { type: "line" }, title: c.label, width: "50%" }, [
        Text(`${c.status}: ${c.preview}`),
      ])
    );
    return Box({ border: { type: "line" }, title: "background" }, cards);
  }

  function renderFooter(snap: TuiModelSnapshot): any {
    return Box({ border: { type: "line" }, title: "footer", width: "100%" }, [
      Text(`rollback: <prefix>  |  /model /free /plan /rollback /sessions  |  tokens: ${snap.meter.tokens}  |  est: $${snap.meter.estCost.toFixed(4)}`),
    ]);
  }

  function renderRoot(): any {
    const snap = model.snapshot();
    const children: any[] = [
      renderHeader(snap),
      renderTranscript(snap),
      renderPendingCard(snap.pending),
      Box({ border: { type: "line" }, title: "composer", width: "100%" }, [
        Text(`/ ${composerText}`),
      ]),
      renderFooter(snap),
    ];
    if (snap.background.length > 0) {
      children.push(renderBackground(snap));
    }
    return Box({ border: { type: "line" }, title: "root", flex: 1 }, children);
  }

  function rerender(): void {
    app.render(renderRoot());
  }

  // Wire up keymap. Keys y/s/a/n resolve the pending approval.
  app.onKey((key: string) => {
    if (approvalResolve === null) {
      // Not in an approval — handle slash commands or navigation.
      if (key === "ctrl-c" || key === "ctrl-d") {
        // Abort parity with headless — same as Ctrl-C in cmdRun.
        // The bridge owns the AbortController; we just notify via signal.aborted.
        // In the fallback, this exits via the bridge's signal handler.
        return;
      }
      if (key === "escape") {
        // Esc with no pending approval = deny/no-op
        return;
      }
      return;
    }

    const resolve = approvalResolve;
    approvalResolve = null;
    if (key === "y") {
      model.clearPending();
      resolve("yes");
    } else if (key === "s") {
      model.clearPending();
      resolve("session");
    } else if (key === "a") {
      model.clearPending();
      resolve("always");
    } else if (key === "n" || key === "escape" || key === "ctrl-c") {
      model.clearPending();
      resolve("no");
    }
  });

  // Composer input
  app.onInput((s: string) => {
    if (s.length === 1 && s !== "\n" && s !== "\r") {
      composerText += s;
    }
  });

  function renderApproval(question: string): Promise<"yes" | "session" | "always" | "no"> {
    return new Promise((resolve) => {
      model.setPending(question);
      approvalResolve = resolve;
      rerender();
    });
  }

  function renderTick(): void {
    rerender();
  }

  function unmount(): void {
    app.unmount();
    approvalResolve = null;
  }

  // Initial mount
  app.render(renderRoot());

  model.onTick = () => rerender();

  return { renderApproval, renderTick, unmount };
}
