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
  const { model, signal, pollBackground } = deps;

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
        case "/model":
        case "/free":
        case "/plan":
          // These affect the running loop — emit as an event for visibility.
          // Real implementation would require LoopEvent widening (killed in v1 spike).
          model.appendEvent(`slash ${cmd.cmd}: noted (live model/provider change needs loop integration)`);
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
