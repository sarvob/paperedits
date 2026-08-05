import type { Candidate, Edl, EdlEntry, Overlay, SegmentEntry } from './types.js';

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
  return { fileHash, entries, overlays: [], aspect: 'source' };
}

/** Output-time extent (seconds) of a single entry on the edited timeline. */
export function entryOutputLen(e: EdlEntry): number {
  return e.kind === 'card' ? e.durationSec : (e.sourceEnd - e.sourceStart) / e.speed;
}

/**
 * Map every entry to its [start,end) window on the OUTPUT timeline (what the
 * viewer sees), accounting for per-segment speed and card durations. This is the
 * time base overlays live in.
 */
export function outputSpans(edl: Edl): Map<string, { start: number; end: number }> {
  const spans = new Map<string, { start: number; end: number }>();
  let t = 0;
  for (const e of edl.entries) {
    const len = entryOutputLen(e);
    spans.set(e.id, { start: t, end: t + len });
    t += len;
  }
  return spans;
}

/** Resolve an overlay's on-screen time window (seconds, output timeline). */
export function overlayWindow(edl: Edl, overlay: Overlay): { start: number; end: number } | null {
  if (overlay.anchor.mode === 'output') {
    return { start: overlay.anchor.start, end: overlay.anchor.start + overlay.anchor.duration };
  }
  const span = outputSpans(edl).get(overlay.anchor.segmentId);
  return span ?? null;
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
    overlays: edl.overlays.map((o) => ({ ...o, anchor: { ...o.anchor } })),
  };
}
