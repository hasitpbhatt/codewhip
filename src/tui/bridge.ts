// TUI bridge: approval-as-promise + onEvent tail subscription.
// Lazy-imports the view so OpenTUI is never loaded in headless mode.
// Never throws into the loop — all errors resolve fail-closed "no".

import type { ApprovalAnswer, AskUser, LoopEvent } from "../loop.js";
import type { TuiModel } from "./model.js";
import type { SlashCommand } from "./view.js";
import { captureBefore } from "../checkpoints.js";

export type TuiBridgeDeps = {
  model: TuiModel;
  signal?: AbortSignal;
  cwd: string;
  /** Optional poller: returns current background task statuses every 500ms. */
  pollBackground?: () => Array<{ id: string; label: string; status: "running" | "done" | "error"; preview: string }>;
  /**
   * Live /model switch (REPL slash commands, roadmap post-H1): validates the
   * target and arms a port the loop picks up at the next turn boundary.
   * Returns a user-facing confirmation line, or the reason it was refused.
   */
  switchModel?: (provider: string, model: string | null) => string;
  /** Free-chain visibility in-run: one line describing usable free hops. */
  describeFree?: () => string;
};

export type TuiBridge = {
  askUser: AskUser;
  onEvent: (event: LoopEvent) => void;
  start: () => void;
  stop: () => void;
};

export type TuiViewHandle = {
  renderApproval: (question: string) => Promise<"yes" | "session" | "always" | "no">;
  renderTick: () => void;
  unmount: () => void;
};

const APPROVAL_TIMEOUT_MS = 30_000;

export function createTuiBridge(deps: TuiBridgeDeps): TuiBridge {
  const { model, signal, pollBackground, switchModel, describeFree } = deps;

  let view: TuiViewHandle | null = null;
  let _rollbackPrefix: string | null = null;
  let pollTimer: NodeJS.Timeout | null = null;

  // Lazily instantiate the view on first need. OpenTUI is imported inside
  // the view module, so this import chain never touches headless.
  async function ensureView(): Promise<TuiViewHandle | null> {
    if (view !== null) return view;
    try {
      const mod = await import("./view.js");
      view = await mod.createTuiView({ model, signal, onSlashCommand });
      return view;
    } catch {
      // OpenTUI unavailable or view failed to mount — fail closed.
      return null;
    }
  }

  function onEvent(event: LoopEvent): void {
    try {
      model.handleLoopEvent(event);
      // Diff-preview: for edit/write tool calls, capture the before-image
      // (~15 lines) to show the user what will change. We parse the event text
      // to extract the tool name + target path. The text format is:
      // "ok edit <path> (ruleId)" or "deny edit <path> (ruleId)" etc.
      if (event.kind === "tool") {
        const m = event.text.match(/^(ok|deny|held|repeat)\s+(edit|write)\s+(\S+)/);
        if (m !== null) {
          const before = captureBefore(deps.cwd, { path: m[3] });
          if (before !== null) {
            model.setDiffPreview(before.rel, before.content);
          }
        } else {
          // Non-edit/write tool event — clear the diff preview.
          model.clearDiffPreview();
        }
      }
      if (view !== null) {
        view.renderTick();
      }
    } catch {
      // Never throw into the loop.
    }
  }

  const askUser: AskUser = (question: string): Promise<ApprovalAnswer> => {
    return new Promise((resolve) => {
      let settled = false;
      const failClosed = (): void => {
        if (settled) return;
        settled = true;
        resolve("no");
      };

      // Timeout: resolve fail-closed "no".
      const timer = setTimeout(failClosed, APPROVAL_TIMEOUT_MS);
      if (signal) {
        if (signal.aborted) {
          clearTimeout(timer);
          failClosed();
          return;
        }
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          failClosed();
        }, { once: true });
      }

      // Render the approval card via the view. If the view can't mount,
      // resolve fail-closed immediately.
      ensureView().then((v) => {
        if (settled) return;
        if (v === null) {
          clearTimeout(timer);
          failClosed();
          return;
        }
        model.setPending(question);
        v.renderApproval(question).then((answer) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          model.clearPending();
          resolve(answer);
        }).catch(() => {
          failClosed();
        });
      }).catch(() => {
        failClosed();
      });
    });
  };

  function onSlashCommand(cmd: SlashCommand): void {
    try {
      
      model.appendEvent(`slash: ${cmd.cmd} ${cmd.args.join(" ")}`);
      switch (cmd.cmd) {
        case "/help":
          model.appendEvent("TUI help: y=approve s=session a=always n/deny Esc no ctrl-c=abort");
          break;
        case "/sessions":
          // Listed from existing sessions — just note it
          model.appendEvent("sessions: use 'codewhip sessions' to list (or --continue)");
          break;
        case "/rollback":
          if (cmd.args.length > 0) {
            _rollbackPrefix = cmd.args[0]!;
            model.appendEvent(`rollback: queued '' — restore after run completes`);
          } else {
            model.appendEvent("rollback: usage /rollback <runId-prefix>");
          }
          break;
        case "/model": {
          // Live switch: the caller (index.ts) validates and builds the port;
          // the loop applies it at the next turn boundary via takePendingSwitch.
          if (switchModel === undefined) {
            model.appendEvent("/model: not wired in this run (headless runs pick the model at launch)");
            break;
          }
          if (cmd.args.length === 0) {
            model.appendEvent("/model: usage /model <provider>[:<model>] — the switch applies from the next turn");
            break;
          }
          const spec = cmd.args[0] ?? "";
          const sep = spec.indexOf(":");
          const provider = sep === -1 ? spec : spec.slice(0, sep);
          const modelId = sep === -1 ? null : spec.slice(sep + 1);
          model.appendEvent(switchModel(provider, modelId));
          break;
        }
        case "/free":
          // Free-chain visibility in-run (roadmap post-H1 item).
          model.appendEvent(describeFree !== undefined ? describeFree() : "/free: not wired in this run — see `codewhip free`");
          break;
        case "/plan":
          // Honest label: plan mode is run-scoped; a mid-run toggle would need
          // permission-ladder re-arming, which the spike deliberately skipped.
          model.appendEvent("/plan: plan mode is run-scoped — exit and rerun with --plan (mid-run toggle not supported)");
          break;
      }
      if (view !== null) view.renderTick();
    } catch {
      // Never throw the loop over.
    }
  }

  function start(): void {
    model.start();
    // Set up the background poll — mirrors the model's 500ms interval.
    if (pollBackground) {
      pollTimer = setInterval(() => {
        try {
          model.pollBackground(pollBackground());
        } catch {
          // Never throw the loop over.
        }
      }, 500);
      if (pollTimer.unref) pollTimer.unref();
    }
  }

  function stop(): void {
    _rollbackPrefix = null;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    model.stop();
    view?.unmount();
    view = null;
  }

  return { askUser, onEvent, start, stop };
}
