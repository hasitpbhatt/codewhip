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

export type TuiModelSnapshot = {
  tail: string[];
  pending: PendingApproval | null;
  background: BackgroundCard[];
  meter: MeterCounters;
};

const MAX_TAIL_LINES = 200;
const POLL_INTERVAL_MS = 500;

export class TuiModel {
  private ring: string[] = [];
  private pending: PendingApproval | null = null;
  private background: BackgroundCard[] = [];
  private meter: MeterCounters = { tokens: 0, estCost: 0, mix: {} };

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

  // --- Snapshot for the view ---
  snapshot(): TuiModelSnapshot {
    return {
      tail: [...this.ring],
      pending: this.pending,
      background: [...this.background],
      meter: { ...this.meter, mix: { ...this.meter.mix } },
    };
  }

  // --- Event adapter: converts LoopEvent to a ring line ---
  handleLoopEvent(e: LoopEvent): void {
    const prefix = e.kind === "tool" ? "▸" : e.kind === "policy" ? "◈" : "◆";
    this.appendEvent(`${prefix} ${e.text}`);
  }
}
