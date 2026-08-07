import { buildSentences, topicBoundaries } from './semantic.js';
import type { Analysis, Candidate } from './types.js';

/**
 * Topics: the unit a plan should actually reason about.
 *
 * A candidate is ~20-90s of continuous speech — too fine-grained to carry an
 * idea, and there are far too many of them to judge individually (asking a
 * model for a verdict per segment is what made summarization scale with video
 * length). A topic is a run of candidates between two lexical-cohesion shifts:
 * on a 30-min source that is ~15 topics rather than 76 segments, which is few
 * enough to judge in ONE bounded call and is the level at which "keep the
 * business parts, drop the technical demos" is even a meaningful instruction.
 */
export interface Topic {
  id: string;
  start: number;
  end: number;
  candidateIds: string[];
  /** representative speech, for the model to judge from */
  text: string;
}

/** What the model decides about each topic. */
export interface TopicVerdict {
  id: string;
  /** short human label, like a chapter title */
  label: string;
  /** 0..1 — how well this serves the user's stated goal */
  relevance: number;
  /** where it sits in the story */
  role: 'opening' | 'core' | 'context' | 'aside' | 'closing';
  /** one sentence, shown to the user as the reason */
  why: string;
}

export interface NarrativePlan {
  topics: Topic[];
  verdicts: Map<string, TopicVerdict>;
}

const PREVIEW_WORDS = 60;
/** A topic shorter than this isn't a subject, it's a beat. */
const MIN_TOPIC_SEC = 90;
/** Few enough that one reply can carry a verdict for every one of them. */
const MAX_TOPICS = 14;

/** Group candidates into topics using the same cohesion shifts as segmentation. */
export function buildTopics(analysis: Analysis, candidates: Candidate[]): Topic[] {
  if (!candidates.length) return [];
  const sentences = buildSentences(analysis.words, 0.8);
  const shiftTimes = topicBoundaries(sentences).map((i) => sentences[i]!.start);

  const groups: Candidate[][] = [];
  let cur: Candidate[] = [];
  for (const c of candidates) {
    // A shift at (or just before) this candidate's start opens a new topic.
    const startsTopic = cur.length > 0 && shiftTimes.some((t) => Math.abs(t - c.start) < 0.5);
    if (startsTopic) {
      groups.push(cur);
      cur = [];
    }
    cur.push(c);
  }
  if (cur.length) groups.push(cur);

  // Every cohesion dip is not a topic. Raw shifts gave 38 groups on a 30-min
  // source, many only seconds long — too granular to be a subject, and too many
  // for the model to return a verdict for each (it answered for 6 of 38, so
  // most of the video ended up unjudged). Merge the shortest neighbour until
  // topics are substantial and few enough to judge in one bounded reply.
  const dur = (g: Candidate[]) => g[g.length - 1]!.end - g[0]!.start;
  while (groups.length > 1) {
    const shortest = groups.reduce((best, g, i) => (dur(g) < dur(groups[best]!) ? i : best), 0);
    if (dur(groups[shortest]!) >= MIN_TOPIC_SEC && groups.length <= MAX_TOPICS) break;
    // Fold into whichever neighbour is shorter, so topics stay balanced.
    const prev = shortest > 0 ? groups[shortest - 1] : null;
    const next = shortest < groups.length - 1 ? groups[shortest + 1] : null;
    const into = !prev ? shortest + 1 : !next ? shortest - 1 : dur(prev) <= dur(next) ? shortest - 1 : shortest + 1;
    const merged = into < shortest ? [...groups[into]!, ...groups[shortest]!] : [...groups[shortest]!, ...groups[into]!];
    groups.splice(Math.min(into, shortest), 2, merged);
  }

  return groups.map((g, i) => {
    const words = g.flatMap((c) => c.speechPreview.split(/\s+/).filter(Boolean));
    return {
      id: `t${String(i + 1).padStart(2, '0')}`,
      start: g[0]!.start,
      end: g[g.length - 1]!.end,
      candidateIds: g.map((c) => c.id),
      text: words.slice(0, PREVIEW_WORDS).join(' '),
    };
  });
}

/**
 * Assemble a cut from topic verdicts, under a hard time budget.
 *
 * This is deliberately deterministic — the model says what each topic MEANS,
 * code decides what fits. Three things the old greedy top-N could not do:
 *
 *  - COVERAGE: spending the whole budget inside one strong topic reads as an
 *    excerpt, not a summary. Each topic is capped at a share of the budget.
 *  - ARC: an opening beat orients the viewer and a closing beat resolves;
 *    top-N by score reliably drops both.
 *  - ENDING: the cut must finish on a topic the model marked as closing (or
 *    failing that, the last relevant one) rather than wherever the budget ran
 *    out mid-thought.
 *
 * Returns the candidate ids to keep at 1x, best-first.
 */
export function assembleNarrative(
  topics: Topic[],
  verdicts: Map<string, TopicVerdict>,
  candidates: Candidate[],
  budgetSec: number,
  opts: { maxTopicShare?: number } = {},
): { keep: string[]; reasons: Map<string, string> } {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const len = (id: string) => {
    const c = byId.get(id);
    return c ? c.end - c.start : 0;
  };
  const reasons = new Map<string, string>();
  const maxShare = opts.maxTopicShare ?? 0.35;

  const scored = topics
    .map((t) => ({ t, v: verdicts.get(t.id) }))
    .filter((x): x is { t: Topic; v: TopicVerdict } => !!x.v)
    .sort((a, b) => b.v.relevance - a.v.relevance);
  if (!scored.length) return { keep: [], reasons };

  // Reserve the arc first, so a strong middle can't crowd out the beats that
  // make the result feel like a piece rather than a clip.
  const opening = scored.find((x) => x.v.role === 'opening') ?? scored[0]!;
  const closing =
    scored.find((x) => x.v.role === 'closing') ??
    // No explicit closing: use the LAST topic that earns its place.
    [...scored].sort((a, b) => b.t.start - a.t.start).find((x) => x.v.relevance >= 0.4);

  const keep: string[] = [];
  let spent = 0;
  const takeFrom = (x: { t: Topic; v: TopicVerdict }, cap: number): void => {
    // Inside a topic, prefer the densest speech — that is where the point is.
    const ordered = [...x.t.candidateIds].sort((a, b) => {
      const ca = byId.get(a);
      const cb = byId.get(b);
      return (cb?.speechPreview.length ?? 0) - (ca?.speechPreview.length ?? 0);
    });
    let usedHere = 0;
    for (const id of ordered) {
      const d = len(id);
      if (d <= 0 || keep.includes(id)) continue;
      if (usedHere + d > cap || spent + d > budgetSec) continue;
      keep.push(id);
      usedHere += d;
      spent += d;
      reasons.set(id, `${x.v.label} — ${x.v.why}`);
    }
  };

  const arcCap = budgetSec * 0.2;
  takeFrom(opening, arcCap);
  if (closing && closing.t.id !== opening.t.id) takeFrom(closing, arcCap);

  // Then fill by relevance, capped per topic so coverage stays broad.
  for (const x of scored) {
    if (spent >= budgetSec) break;
    if (x.t.id === opening.t.id || x.t.id === closing?.t.id) continue;
    if (x.v.relevance < 0.25) continue; // explicitly judged off-goal
    takeFrom(x, budgetSec * maxShare);
  }

  // Keep chronological order for the EDL; the ending is whatever the closing
  // topic contributed, which is the point of reserving it.
  keep.sort((a, b) => (byId.get(a)?.start ?? 0) - (byId.get(b)?.start ?? 0));
  return { keep, reasons };
}
