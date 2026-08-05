import type { Analysis, Atom, Candidate, Word } from './types.js';

/** Tunables for segmentation. Exposed so heuristic mode / UI can adjust them. */
export interface SegmentConfig {
  /** a gap between words longer than this (s) is a silence boundary */
  silenceGapSec: number;
  /** target minimum atom length (s) — shorter atoms get merged into neighbors */
  minAtomSec: number;
  /** candidates stop growing past this length (s) */
  maxCandidateSec: number;
  /** words to keep in a candidate's speech preview */
  previewWords: number;
}

export const DEFAULT_SEGMENT_CONFIG: SegmentConfig = {
  silenceGapSec: 0.8,
  minAtomSec: 4,
  maxCandidateSec: 90,
  previewWords: 25,
};

const SENTENCE_END = /[.!?]$/;

/** Deterministic, content-derived id so re-import of the same file is stable. */
function boundaryId(prefix: string, start: number, end: number): string {
  return `${prefix}_${start.toFixed(2)}_${end.toFixed(2)}`;
}

/**
 * Build atoms: the smallest units a cut may land on. Boundaries are placed at
 * silences > silenceGapSec, sentence ends, and scene cuts, then any atom below
 * minAtomSec is merged forward so we never emit slivers.
 */
export function buildAtoms(analysis: Analysis, cfg: SegmentConfig = DEFAULT_SEGMENT_CONFIG): Atom[] {
  const { words, sceneCuts, durationSec } = analysis;

  // Collect candidate boundary times with a reason, then sort/dedupe.
  const marks: { at: number; reason: Atom['reason'] }[] = [{ at: 0, reason: 'start' }];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if (next && next.start - w.end >= cfg.silenceGapSec) {
      marks.push({ at: w.end, reason: 'silence' });
    } else if (SENTENCE_END.test(w.text)) {
      marks.push({ at: w.end, reason: 'sentence' });
    }
  }
  for (const cut of sceneCuts) marks.push({ at: cut, reason: 'scene' });
  marks.push({ at: durationSec, reason: 'end' });

  marks.sort((a, b) => a.at - b.at);

  // Fallback for unstructured video (e.g. a silent screen recording with no
  // speech and no scene cuts): fill any long gap between boundaries with regular
  // interval marks, so the timeline is chopped into editable pieces instead of
  // one giant block. Only triggers on genuinely long gaps.
  const INTERVAL = 15; // seconds
  const withIntervals: typeof marks = [];
  for (let i = 0; i < marks.length; i++) {
    withIntervals.push(marks[i]!);
    const next = marks[i + 1];
    if (next && next.at - marks[i]!.at > INTERVAL * 1.5) {
      for (let t = marks[i]!.at + INTERVAL; t < next.at - INTERVAL * 0.5; t += INTERVAL) {
        withIntervals.push({ at: Number(t.toFixed(2)), reason: 'interval' });
      }
    }
  }
  withIntervals.sort((a, b) => a.at - b.at);
  marks.length = 0;
  marks.push(...withIntervals);

  // Turn sorted marks into [start,end) atoms, dropping zero-length spans.
  const raw: Atom[] = [];
  for (let i = 0; i < marks.length - 1; i++) {
    const start = marks[i]!.at;
    const end = marks[i + 1]!.at;
    if (end - start <= 0.001) continue;
    raw.push({ id: boundaryId('atom', start, end), start, end, reason: marks[i + 1]!.reason });
  }

  // Merge atoms shorter than minAtomSec into the following atom so no cut point
  // is uselessly small — but NEVER dissolve a scene-cut boundary (prev.reason
  // 'scene' means prev.end is a hard visual cut). Merging across it would hide
  // the scene change from candidate segmentation.
  const merged: Atom[] = [];
  for (const atom of raw) {
    const prev = merged[merged.length - 1];
    if (prev && prev.reason !== 'scene' && prev.end - prev.start < cfg.minAtomSec) {
      merged[merged.length - 1] = {
        id: boundaryId('atom', prev.start, atom.end),
        start: prev.start,
        end: atom.end,
        reason: atom.reason,
      };
    } else {
      merged.push({ ...atom });
    }
  }
  return merged;
}

function wordsInSpan(words: Word[], start: number, end: number): Word[] {
  return words.filter((w) => w.start >= start - 1e-6 && w.start < end);
}

function meanActivity(activityPerSec: number[], start: number, end: number): number {
  const lo = Math.floor(start);
  const hi = Math.max(lo + 1, Math.ceil(end));
  let sum = 0;
  let n = 0;
  for (let s = lo; s < hi && s < activityPerSec.length; s++) {
    sum += activityPerSec[s] ?? 0;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

/**
 * Merge adjacent atoms into candidates (~20–90 s): grow while the speaker keeps
 * talking (no long silence), no scene cut falls on the join, and activity stays
 * in the same regime. This is the unit the agent reasons about.
 */
export function buildCandidates(
  analysis: Analysis,
  atoms: Atom[],
  cfg: SegmentConfig = DEFAULT_SEGMENT_CONFIG,
): Candidate[] {
  const sceneCutSet = analysis.sceneCuts;
  const isSceneJoin = (t: number) => sceneCutSet.some((c) => Math.abs(c - t) < 0.05);

  const groups: Atom[][] = [];
  let current: Atom[] = [];

  for (const atom of atoms) {
    if (current.length === 0) {
      current = [atom];
      continue;
    }
    const spanStart = current[0]!.start;
    // The boundary at `atom.start` is the END reason of the previous atom.
    const boundaryReason = current[current.length - 1]!.reason;
    const wouldBeLong = atom.end - spanStart > cfg.maxCandidateSec;
    const sceneBreak = isSceneJoin(atom.start) || boundaryReason === 'scene';
    // Silence, and interval marks (unstructured-video fallback), end a candidate.
    const silenceBreak = boundaryReason === 'silence' || boundaryReason === 'interval';

    if (wouldBeLong || sceneBreak || silenceBreak) {
      groups.push(current);
      current = [atom];
    } else {
      current.push(atom);
    }
  }
  if (current.length) groups.push(current);

  // Merge away degenerate near-zero candidates (e.g. a scene cut a few frames
  // before end-of-file leaves a 0.04s sliver) by folding them into the previous
  // candidate. A short FIRST candidate has no previous, so it survives.
  const MIN_CANDIDATE_SEC = 0.5;
  const mergedGroups: Atom[][] = [];
  for (const group of groups) {
    const dur = group[group.length - 1]!.end - group[0]!.start;
    const prev = mergedGroups[mergedGroups.length - 1];
    if (dur < MIN_CANDIDATE_SEC && prev) prev.push(...group);
    else mergedGroups.push(group);
  }

  return mergedGroups.map((group, i) => {
    const start = group[0]!.start;
    const end = group[group.length - 1]!.end;
    const spanWords = wordsInSpan(analysis.words, start, end);
    const speechPreview = spanWords
      .slice(0, cfg.previewWords)
      .map((w) => w.text)
      .join(' ');

    const objects = [
      ...new Set(
        analysis.detections
          .filter((d) => d.at >= start && d.at < end)
          .flatMap((d) => d.labels),
      ),
    ];
    const caption = analysis.captions.find((c) => c.at >= start && c.at < end)?.text;

    return {
      id: `c${String(i + 1).padStart(3, '0')}`,
      index: i + 1,
      start,
      end,
      atomIds: group.map((a) => a.id),
      speechPreview,
      activity: Number(meanActivity(analysis.activityPerSec, start, end).toFixed(3)),
      objects,
      caption,
    } satisfies Candidate;
  });
}

/** Convenience: full segmentation from analysis to candidates. */
export function segment(
  analysis: Analysis,
  cfg: SegmentConfig = DEFAULT_SEGMENT_CONFIG,
): { atoms: Atom[]; candidates: Candidate[] } {
  const atoms = buildAtoms(analysis, cfg);
  const candidates = buildCandidates(analysis, atoms, cfg);
  return { atoms, candidates };
}
