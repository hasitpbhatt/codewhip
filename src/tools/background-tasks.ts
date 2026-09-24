import { execFile, execFileSync, type ChildProcess } from "node:child_process";

/**
 * Process-scoped background task manager: the spawned children behind
 * `run_in_background` / `task_output` / `task_stop`. One instance per
 * server/CLI process, cleared on restart (tasks are not resumed). Concurrency
 * and buffered output are both capped so a runaway child cannot drain memory.
 */

export const MAX_CONCURRENT = 8;
const MAX_OUTPUT_CHARS = 256 * 1024; // 256KB, like evot's spill cap
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 120_000;
export const MIN_TIMEOUT_MS = 1000;
/** Foreground-wait handoff window when the model asks to block briefly. */
export const MAX_WAIT_MS = 60_000;

export type TaskState = {
  id: string;
  command: string;
  startedTs: number;
  /** null while running; set on natural exit / kill. */
  exitCode: number | null;
  killed: boolean;
  timedOut: boolean;
  done: boolean;
  output: string;
  child: ChildProcess;
};

const tasks = new Map<string, TaskState>();
let taskSeq = 0;

export function getTask(id: string): TaskState | undefined {
  return tasks.get(id);
}

export function taskCount(): number {
  return tasks.size;
}

export function cap(s: string): string {
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n…[output truncated at 256KB]" : s;
}

/**
 * Kill the WHOLE process tree. On Windows, `child.kill()` (Node's SIGTERM)
 * maps to TerminateProcess on the direct child only — the powershell.exe
 * shell dies and every descendant (the dev server npm spawned) survives
 * holding its port, which made every timed-out background task leak. `taskkill
 * /T /F` takes the tree. On POSIX the child is spawned detached (own process
 * group), so a group signal reaches npm/node descendants too.
 */
function treeKill(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } catch { /* already gone */ }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ }
    }
  }
}

/** Mark a task killed and take its process tree down (tree kill, not a bare
 * SIGTERM: on win32 a bare kill orphans every descendant — the dev server
 * keeps the port and the next run dies EADDRINUSE and blames the tool). */
export function killTask(state: TaskState): void {
  state.killed = true;
  if (!state.child.killed && state.child.pid !== undefined) {
    treeKill(state.child.pid);
  }
}

export function spawn(cwd: string, command: string, timeoutMs: number): TaskState {
  taskSeq += 1;
  const id = `task_${taskSeq}`;
  const isWin = process.platform === "win32";
  const shell = isWin ? "powershell.exe" : "/bin/sh";
  const shellArgs = isWin
    ? ["-NoProfile", "-NonInteractive", "-Command", command]
    : ["-c", command];
  const state: TaskState = {
    id,
    command,
    startedTs: Date.now(),
    exitCode: null,
    killed: false,
    timedOut: false,
    done: false,
    output: "",
    // Node's own `timeout` is a BACKSTOP 5s after ours (in case treeKill
    // fails); the real deadline is the kill timer below, which takes the
    // whole tree instead of orphaning it.
    child: execFile(shell, shellArgs, {
      cwd,
      timeout: timeoutMs + 5000,
      maxBuffer: 512 * 1024,
      windowsHide: true,
      ...(isWin ? {} : { detached: true }),
    }),
  };
  let exited = false;
  const killTimer = setTimeout(() => {
    if (exited || state.killed || state.child.pid === undefined) return;
    state.timedOut = true;
    treeKill(state.child.pid);
  }, timeoutMs);
  killTimer.unref?.();
  let buf = "";
  const append = (s: string): void => {
    buf += s;
    if (buf.length > MAX_OUTPUT_CHARS) buf = buf.slice(buf.length - MAX_OUTPUT_CHARS);
    state.output = buf;
  };
  state.child.stdout?.on("data", (d) => append(d.toString()));
  state.child.stderr?.on("data", (d) => append(d.toString()));
  state.child.on("error", (err) => append(`\n[error] ${err.message}`));
  state.child.on("close", (code, signal) => {
    exited = true;
    clearTimeout(killTimer);
    state.exitCode = code;
    state.done = true;
    if (signal === "SIGTERM" || state.killed) state.killed = true;
  });
  state.child.on("exit", (code, signal) => {
    if (signal !== null && !state.killed && code === null) state.timedOut = true;
  });
  tasks.set(id, state);
  return state;
}

// Read-only view for the status projection in background-status.ts. The state
// handles stay inside this module — callers must not mutate them.
export function allTasks(): TaskState[] {
  return [...tasks.values()];
}

/** Block until the task finishes or `waitMs` elapses — whichever comes first. */
export async function waitUntilDone(state: TaskState, waitMs: number): Promise<void> {
  const deadline = Date.now() + Math.min(waitMs, MAX_WAIT_MS);
  while (!state.done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(() => r(undefined), 50));
  }
}
