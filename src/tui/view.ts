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
    // Eagerly try to lazy-import OpenTUI. If it's not installed (or the
    // renderer can't initialize on this runtime/OS), we fall back to the
    // readline view so the TUI bridge still functions everywhere. The
    // indirection keeps the optional dep out of static type resolution:
    // builds are identical whether or not it happens to be installed.
    const opentuiSpec = "@opentui/core";
    const mod = (await import(opentuiSpec)) as {
      createCliRenderer?: (opts?: Record<string, unknown>) => Promise<OpentuiRenderer> | OpentuiRenderer;
      Box?: (props: Record<string, unknown>, children?: unknown[]) => unknown;
      Text?: (props: Record<string, unknown>) => unknown;
    };
    return await createOpentuiView(deps, mod);
  } catch {
    // OpenTUI not installed or unsupported here — use the fallback.
    return createFallbackView(deps);
  }
}

type OpentuiRenderer = {
  render?: (el: unknown) => void;
  destroy?: () => void;
  keyInput?: { on?: (ev: string, cb: (k: { name?: string; sequence?: string }) => void) => void };
};

// Full OpenTUI-backed view — only loaded when the package is available.
// Every call is guarded: if the API differs from what we expect, the factory
// throws and createTuiView's catch falls back to the readline view.
async function createOpentuiView(deps: TuiViewDeps, mod: {
  createCliRenderer?: (opts?: Record<string, unknown>) => Promise<OpentuiRenderer> | OpentuiRenderer;
  Box?: (props: Record<string, unknown>, children?: unknown[]) => unknown;
  Text?: (props: Record<string, unknown>) => unknown;
}): Promise<TuiViewHandle> {
  if (mod.createCliRenderer == null || mod.Box == null || mod.Text == null) {
    throw new Error("opentui api not recognized");
  }
  const renderer = await mod.createCliRenderer({});
  if (typeof renderer.render !== "function" || typeof renderer.destroy !== "function") {
    renderer.destroy?.();
    throw new Error("opentui renderer api not recognized");
  }
  const { model } = deps;
  const Box = mod.Box;
  const Text = mod.Text;
  let approvalResolve: ((v: "yes" | "session" | "always" | "no") => void) | null = null;
  let composerText = "";

  function renderPendingCard(pending: PendingApproval | null): unknown {
    if (!pending) return null;
    return Box({ borderStyle: "single", title: "approval", width: "100%" }, [
      Text({ content: pending.question }),
      Text({ content: "[y]es  [s]ession  [a]lways  [n]o / Esc" }),
    ]);
  }

  function renderHeader(snap: TuiModelSnapshot): unknown {
    return Box({ borderStyle: "single", title: "codewhip tui", width: "100%" }, [
      Text({ content: `run: ${snap.runId?.slice(0, 8) ?? "<pending>"}  |  tokens: ${snap.meter.tokens}  |  est: $${snap.meter.estCost.toFixed(4)}` }),
    ]);
  }

  function renderTranscript(snap: TuiModelSnapshot): unknown {
    const lines = snap.tail.length === 0
      ? [Text({ content: "(no events yet)" })]
      : snap.tail.map((l) => Text({ content: l }));
    return Box({ borderStyle: "single", title: "transcript", flexGrow: 1 }, lines);
  }

  function renderBackground(snap: TuiModelSnapshot): unknown {
    if (snap.background.length === 0) return null;
    const cards = snap.background.map((c: BackgroundCard) =>
      Box({ borderStyle: "single", title: c.label, width: "50%" }, [
        Text({ content: `${c.status}: ${c.preview}` }),
      ])
    );
    return Box({ borderStyle: "single", title: "background" }, cards);
  }

  function renderFooter(snap: TuiModelSnapshot): unknown {
    const rollbackId = snap.runId ? snap.runId.slice(0, 8) : "<pending>";
    const revoke = snap.pending ? " | Esc = revoke" : "";
    return Box({ borderStyle: "single", title: "footer", width: "100%" }, [
      Text({ content: `rollback: ${rollbackId}  |  /model /free /plan /rollback /sessions  |  tokens: ${snap.meter.tokens}  |  est: $${snap.meter.estCost.toFixed(4)}${revoke}` }),
    ]);
  }

  function renderRoot(): unknown {
    const snap = model.snapshot();
    const children: unknown[] = [
      renderHeader(snap),
      renderTranscript(snap),
      renderPendingCard(snap.pending),
      Box({ borderStyle: "single", title: "composer", width: "100%" }, [
        Text({ content: `/ ${composerText}` }),
      ]),
      renderFooter(snap),
    ];
    if (snap.background.length > 0) {
      const bg = renderBackground(snap);
      if (bg !== null) children.push(bg);
    }
    return Box({ borderStyle: "single", title: "root", height: "100%" }, children.filter((c) => c !== null));
  }

  function rerender(): void {
    renderer.render?.(renderRoot());
  }

  // Wire up keymap. Keys y/s/a/n resolve the pending approval.
  renderer.keyInput?.on?.("key", (key: { name?: string; sequence?: string }) => {
    const name = key.name ?? key.sequence ?? "";
    if (approvalResolve !== null) {
      const resolve = approvalResolve;
      approvalResolve = null;
      if (name === "y") {
        model.clearPending();
        resolve("yes");
      } else if (name === "s") {
        model.clearPending();
        resolve("session");
      } else if (name === "a") {
        model.clearPending();
        resolve("always");
      } else {
        model.clearPending();
        resolve("no");
      }
      return;
    }
    if (name === "escape") {
      return;
    }
    if (name === "return" || name === "enter") {
      if (composerText.length > 0) {
        const cmd = parseSlashCommand(composerText);
        if (cmd !== null && deps.onSlashCommand !== undefined) {
          deps.onSlashCommand(cmd);
        }
        composerText = "";
        rerender();
      }
      return;
    }
    if (name === "backspace") {
      composerText = composerText.slice(0, -1);
      rerender();
      return;
    }
    // printable char
    const ch = key.sequence ?? "";
    if (ch.length === 1 && ch >= " ") {
      composerText += ch;
      rerender();
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
    renderer.destroy?.();
    approvalResolve = null;
  }

  // Initial mount
  rerender();

  model.onTick = () => rerender();

  return { renderApproval, renderTick, unmount };
}
