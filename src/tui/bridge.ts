// TUI bridge: approval-as-promise + onEvent tail subscription.
// Lazy-imports the view so OpenTUI is never loaded in headless mode.
// Never throws into the loop — all errors resolve fail-closed "no".

import type { ApprovalAnswer, AskUser, LoopEvent } from "../loop.js";
import type { TuiModel } from "./model.js";

export type TuiBridgeDeps = {
  model: TuiModel;
  signal?: AbortSignal;
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
  const { model, signal } = deps;

  let view: TuiViewHandle | null = null;

  // Lazily instantiate the view on first need. OpenTUI is imported inside
  // the view module, so this import chain never touches headless.
  async function ensureView(): Promise<TuiViewHandle | null> {
    if (view !== null) return view;
    try {
      const mod = await import("./view.js");
      view = await mod.createTuiView({ model, signal });
      return view;
    } catch {
      // OpenTUI unavailable or view failed to mount — fail closed.
      return null;
    }
  }

  function onEvent(event: LoopEvent): void {
    try {
      model.handleLoopEvent(event);
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

  function start(): void {
    model.start();
  }

  function stop(): void {
    model.stop();
    view?.unmount();
    view = null;
  }

  return { askUser, onEvent, start, stop };
}
