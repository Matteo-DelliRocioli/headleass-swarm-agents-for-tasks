// ---------------------------------------------------------------------------
// Stuck detector — alerts when a run shows no progress for too long
// ---------------------------------------------------------------------------

import type { SwarmRunSummary } from "./k8s.js";

interface RunState {
  lastConfidence: number | undefined;
  lastLoop: number | undefined;
  lastChangeTime: number;
  alerted: boolean;
}

export class StuckDetector {
  private state = new Map<string, RunState>();
  private thresholdMs: number;

  constructor(thresholdMinutes = 10) {
    this.thresholdMs = thresholdMinutes * 60 * 1000;
  }

  /**
   * Update state for a run. Returns true if the run just became stuck
   * (first time crossing the threshold since last progress).
   */
  update(run: SwarmRunSummary): boolean {
    // Only track Running/Reviewing runs
    if (run.phase !== "Running" && run.phase !== "Reviewing") {
      this.state.delete(run.name);
      return false;
    }

    const prev = this.state.get(run.name);
    const now = Date.now();

    if (!prev) {
      // First time seeing this run
      this.state.set(run.name, {
        lastConfidence: run.confidence,
        lastLoop: run.currentLoop,
        lastChangeTime: now,
        alerted: false,
      });
      return false;
    }

    // Check if progress was made
    const progressMade =
      run.confidence !== prev.lastConfidence ||
      run.currentLoop !== prev.lastLoop;

    if (progressMade) {
      prev.lastConfidence = run.confidence;
      prev.lastLoop = run.currentLoop;
      prev.lastChangeTime = now;
      prev.alerted = false;
      return false;
    }

    // No progress — check if stuck threshold exceeded
    const elapsed = now - prev.lastChangeTime;
    if (elapsed >= this.thresholdMs && !prev.alerted) {
      prev.alerted = true;
      return true; // First stuck alert
    }

    return false;
  }

  /** Remove a run from tracking (e.g., on delete). */
  remove(name: string): void {
    this.state.delete(name);
  }

  /** Get all currently stuck run names. */
  getStuckRuns(): string[] {
    return [...this.state.entries()]
      .filter(([, s]) => s.alerted)
      .map(([name]) => name);
  }
}
