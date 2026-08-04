import type { Candidate, Edl, SegmentEntry } from './types.js';

/**
 * Build the initial EDL from candidates: one 1× segment per candidate, all
 * classified `key` until an op says otherwise. Nothing is pinned yet.
 */
export function initialEdl(fileHash: string, candidates: Candidate[]): Edl {
  const entries: SegmentEntry[] = candidates.map((c) => ({
    kind: 'segment',
    id: `e_${c.id}`,
    candidateId: c.id,
    index: c.index,
    sourceStart: c.start,
    sourceEnd: c.end,
    speed: 1,
    class: 'key',
    pinned: false,
  }));
  return { fileHash, entries, aspect: 'source' };
}

/** Total output duration accounting for per-segment speed and card durations. */
export function outputDuration(edl: Edl): number {
  let total = 0;
  for (const e of edl.entries) {
    if (e.kind === 'card') total += e.durationSec;
    else total += (e.sourceEnd - e.sourceStart) / e.speed;
  }
  return total;
}

/** Structural (deep) clone — every op application works on a fresh copy. */
export function cloneEdl(edl: Edl): Edl {
  return {
    fileHash: edl.fileHash,
    aspect: edl.aspect,
    entries: edl.entries.map((e) => ({ ...e })),
  };
}
