import { cloneEdl } from './edl.js';
import type { Edl } from './types.js';

export interface HistoryStep {
  /** human label shown in the undo menu, e.g. the instruction text */
  label: string;
  edl: Edl;
}

/**
 * A single undo/redo stack that spans BOTH prompt turns and manual edits, so
 * Ctrl-Z has one meaning across the whole session. Each committed state is a
 * full EDL snapshot (EDLs are small — a list of blocks — so this is cheap and
 * avoids inverse-op bookkeeping).
 */
export class History {
  private past: HistoryStep[] = [];
  private future: HistoryStep[] = [];
  private current: HistoryStep;

  constructor(initial: Edl, label = 'import') {
    this.current = { label, edl: cloneEdl(initial) };
  }

  get edl(): Edl {
    return this.current.edl;
  }

  get label(): string {
    return this.current.label;
  }

  /** Commit a new state, clearing the redo stack. One turn = one commit. */
  commit(edl: Edl, label: string): void {
    this.past.push(this.current);
    this.current = { label, edl: cloneEdl(edl) };
    this.future = [];
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Revert one step; returns the label of the step that was undone. */
  undo(): string | null {
    const prev = this.past.pop();
    if (!prev) return null;
    const undone = this.current.label;
    this.future.push(this.current);
    this.current = prev;
    return undone;
  }

  redo(): string | null {
    const nextStep = this.future.pop();
    if (!nextStep) return null;
    this.past.push(this.current);
    this.current = nextStep;
    return nextStep.label;
  }

  /** Timeline of committed labels (oldest → current), for a history panel. */
  timeline(): string[] {
    return [...this.past, this.current].map((s) => s.label);
  }
}
