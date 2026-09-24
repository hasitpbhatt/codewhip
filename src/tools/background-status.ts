import { allTasks } from "./background-tasks.js";

/**
 * Read-only snapshot for TUI polling. Returns only safe fields — no child
 * process handles or internal state. Used by the TUI's 500ms background poll.
 */

export type TaskStatus = {
  id: string;
  command: string;
  status: "running" | "done" | "error";
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  outputPreview: string;
};

export function getTaskStatuses(): TaskStatus[] {
  const out: TaskStatus[] = [];
  for (const state of allTasks()) {
    out.push({
      id: state.id,
      command: state.command,
      status: state.timedOut ? "error" : state.done ? "done" : "running",
      exitCode: state.exitCode,
      killed: state.killed,
      timedOut: state.timedOut,
      outputPreview: state.output.slice(0, 200),
    });
  }
  return out;
}
