// In-memory TUI model — no persistence, no files, no new writers.
// Pure state ring for the spike: transcript tail, pending approval,
// background card states, and meter counters.

import type { LoopEvent } from "../loop.js";

export type ApprovalKind = "deny:shell" | "deny:edit" | "allow:ask" | "allow:yolo" | "other";

export type PendingApproval = {
  question: string;
  kind: ApprovalKind;
};

export type BackgroundCard = {
  id: string;
  label: string;
  status: "running" | "done" | "error";
  preview: string;
};

export type MeterCounters = {
  tokens: number;
  estCost: number;
  mix: Record<string, string>;
};

export type DiffPreview = {
  rel: string;
  lines: string[];
};

export type TuiModelSnapshot = {
  tail: string[];
  pending: PendingApproval | null;
  background: BackgroundCard[];
  meter: MeterCounters;
  diffPreview: DiffPreview | null;
  runId: string | null;
};

const MAX_TAIL_LINES = 200;
const POLL_INTERVAL_MS = 500;

export class TuiModel {
  private ring: string[] = [];
  private pending: PendingApproval | null = null;
  private background: BackgroundCard[] = [];
  private meter: MeterCounters = { tokens: 0, estCost: 0, mix: {} };
  private diffPreview: DiffPreview | null = null;
  private runId: string | null = null;

  // Poll callback set by the bridge; called every POLL_INTERVAL_MS.
  // The bridge owns the actual background-task polling; the model just
  // stores state and exposes a snapshot.
  onTick?: () => void;

  private pollTimer: NodeJS.Timeout | null = null;
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.pollTimer = setInterval(() => {
      this.onTick?.();
    }, POLL_INTERVAL_MS);
    // Don't keep the process alive for the poll alone.
    if (this.pollTimer.unref) this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.started = false;
  }

  // --- Transcript ring ---
  appendEvent(line: string): void {
    this.ring.push(line);
    if (this.ring.length > MAX_TAIL_LINES) {
      this.ring = this.ring.slice(this.ring.length - MAX_TAIL_LINES);
    }
    this.onTick?.();
  }

  // --- Pending approval ---
  setPending(q: string, kind: ApprovalKind = "other"): void {
    this.pending = { question: q, kind };
    this.onTick?.();
  }

  clearPending(): void {
    this.pending = null;
    this.onTick?.();
  }

  // --- Background ---
  setBackground(cards: BackgroundCard[]): void {
    this.background = [...cards];
    this.onTick?.();
  }

  // --- Meter ---
  setMeter(m: MeterCounters): void {
    this.meter = m;
    this.onTick?.();
  }

  // --- Diff preview from captureBefore (~15 lines) ---
  setDiffPreview(rel: string, content: string | null): void {
    const lines = content ? content.split("\n").slice(0, 15) : ["(new file)"];
    this.diffPreview = { rel, lines };
    this.onTick?.();
  }

  clearDiffPreview(): void {
    this.diffPreview = null;
    this.onTick?.();
  }

  // --- Run ID for rollback footer ---
  setRunId(id: string): void {
    this.runId = id;
    this.onTick?.();
  }

  // --- Background task polling ---
  pollBackground(cards: { id: string; label: string; status: "running" | "done" | "error"; preview: string }[]): void {
    this.setBackground(cards);
  }

  // --- Snapshot for the view ---
  snapshot(): TuiModelSnapshot {
    return {
      tail: [...this.ring],
      pending: this.pending,
      background: [...this.background],
      meter: { ...this.meter, mix: { ...this.meter.mix } },
      diffPreview: this.diffPreview,
      runId: this.runId,
    };
  }

  // --- Event adapter: converts LoopEvent to a ring line ---
  handleLoopEvent(e: LoopEvent): void {
    const prefix = e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆";
    this.appendEvent(`${prefix} ${e.text}`);
  }
}
