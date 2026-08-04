import type { Atom, Edl, EdlEntry, SegmentEntry } from './types.js';

export interface PostProcessConfig {
  /** key (≈1×) runs shorter than this (s, source time) get flipped to skip */
  minKeyIslandSec: number;
  /** skip (fast) runs shorter than this (s, source time) get flipped to key */
  minSkipIslandSec: number;
}

export const DEFAULT_POSTPROCESS: PostProcessConfig = {
  minKeyIslandSec: 3,
  minSkipIslandSec: 5,
};

function isSegment(e: EdlEntry): e is SegmentEntry {
  return e.kind === 'segment';
}

function sourceLen(e: SegmentEntry): number {
  return e.sourceEnd - e.sourceStart;
}

/**
 * Flip tiny same-class islands to their neighbour's class so we never emit a
 * 2-second slow blip inside a fast montage (or vice-versa). Runs of pinned
 * segments are left alone.
 */
export function flipShortIslands(edl: Edl, cfg: PostProcessConfig = DEFAULT_POSTPROCESS): Edl {
  const entries = edl.entries.map((e) => ({ ...e }));

  // Group consecutive segments (cards break runs) into class-runs.
  type Run = { idxs: number[]; cls: SegmentEntry['class']; len: number; pinned: boolean };
  const runs: Run[] = [];
  entries.forEach((e, i) => {
    if (!isSegment(e)) {
      runs.push({ idxs: [], cls: 'key', len: 0, pinned: true }); // card = hard break
      return;
    }
    const last = runs[runs.length - 1];
    if (last && last.idxs.length && last.cls === e.class) {
      last.idxs.push(i);
      last.len += sourceLen(e);
      last.pinned = last.pinned || e.pinned;
    } else {
      runs.push({ idxs: [i], cls: e.class, len: sourceLen(e), pinned: e.pinned });
    }
  });

  const realRuns = runs.filter((r) => r.idxs.length > 0);
  for (let i = 0; i < realRuns.length; i++) {
    const run = realRuns[i]!;
    if (run.pinned) continue;
    const threshold = run.cls === 'key' ? cfg.minKeyIslandSec : cfg.minSkipIslandSec;
    if (run.len >= threshold) continue;
    // Flip to the class of whichever neighbour exists (prefer previous).
    const neighbour = realRuns[i - 1] ?? realRuns[i + 1];
    if (!neighbour || neighbour.cls === run.cls) continue;
    for (const idx of run.idxs) {
      const e = entries[idx]!;
      if (isSegment(e)) e.class = neighbour.cls;
    }
  }
  return { ...edl, entries };
}

/**
 * Merge adjacent segments that share a class, speed, audio and label and whose
 * source ranges are contiguous — collapsing them into one entry. Pinned entries
 * and entries separated by a card are never merged.
 */
export function mergeAdjacent(edl: Edl): Edl {
  const out: EdlEntry[] = [];
  for (const e of edl.entries) {
    const prev = out[out.length - 1];
    if (
      prev &&
      isSegment(prev) &&
      isSegment(e) &&
      !prev.pinned &&
      !e.pinned &&
      prev.class === e.class &&
      prev.speed === e.speed &&
      prev.label === e.label &&
      prev.audio === e.audio &&
      Math.abs(prev.sourceEnd - e.sourceStart) < 0.01
    ) {
      out[out.length - 1] = { ...prev, sourceEnd: e.sourceEnd };
    } else {
      out.push({ ...e });
    }
  }
  return { ...edl, entries: out };
}

/** Nearest atom boundary to a time (from the sorted set of all atom edges). */
function snap(time: number, boundaries: number[]): number {
  let best = time;
  let bestD = Infinity;
  for (const b of boundaries) {
    const d = Math.abs(b - time);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Snap every segment in/out point to the nearest atom boundary. This is what
 * guarantees "no cut mid-word": atoms only break at silences, sentence ends and
 * scene cuts. Pinned entries keep their hand-set boundaries.
 */
export function snapToAtoms(edl: Edl, atoms: Atom[]): Edl {
  const boundaries = [...new Set(atoms.flatMap((a) => [a.start, a.end]))].sort((x, y) => x - y);
  const entries = edl.entries.map((e) => {
    if (!isSegment(e) || e.pinned) return { ...e };
    return { ...e, sourceStart: snap(e.sourceStart, boundaries), sourceEnd: snap(e.sourceEnd, boundaries) };
  });
  return { ...edl, entries };
}

/**
 * The full always-on normalization pass applied to EDL *state* after every
 * edit: flip tiny islands, then snap boundaries to atoms.
 *
 * NOTE: `mergeAdjacent` is deliberately NOT run here. The EDL keeps exactly one
 * entry per candidate so the agent can always target a candidate by id/number;
 * collapsing identical neighbours into one block would erase that identity (and,
 * on the initial all-key/1× EDL, would fuse the entire video into a single
 * untargetable segment). Merging is a *render/display* concern — `planRender`
 * and the collapsed-timeline view call `mergeAdjacent` themselves.
 */
export function normalize(
  edl: Edl,
  atoms: Atom[],
  cfg: PostProcessConfig = DEFAULT_POSTPROCESS,
): Edl {
  let out = flipShortIslands(edl, cfg);
  out = snapToAtoms(out, atoms);
  // Keep user-visible ordinals dense.
  let n = 0;
  out.entries = out.entries.map((e) => (isSegment(e) ? { ...e, index: ++n } : e));
  return out;
}

/**
 * Collapse contiguous segments that share every render-relevant property into
 * one block. Used for the render plan and the optional collapsed timeline view
 * — never on the authoritative EDL state (see `normalize`).
 */
export function mergedForRender(edl: Edl): Edl {
  return mergeAdjacent(edl);
}
