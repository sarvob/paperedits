import type { Word } from './types.js';

/**
 * Where meaning is safe to cut.
 *
 * Acoustic boundaries (silences, scene cuts, fixed intervals) say nothing about
 * whether a thought is finished — a camera angle changes mid-clause all the
 * time. This module derives boundaries from the WORDS: sentence units first,
 * then topic shifts between them, so a cut lands where an idea has closed
 * rather than wherever the audio happened to dip.
 */

export interface Sentence {
  start: number;
  end: number;
  text: string;
  /** content tokens used for the topic-cohesion measure */
  tokens: string[];
}

const SENTENCE_END = /[.!?]["')\]]?$/;

/**
 * Words a thought cannot end on.
 *
 * Speakers hesitate mid-clause — "…to make it lightweight and <pause>" — and a
 * pure pause rule treats that as a finished sentence, so the cut lands on a
 * dangling conjunction. Measured in the exported cut: "...to make it lightweight
 * and" ran straight into "So I do all that stuff here." If the last word is a
 * function word, the speaker is still mid-thought; keep going.
 */
const DANGLING = new Set(
  ('and but or so nor yet for to of in on at by with from as that which who because if when while ' +
    'the a an is are was were be been being it its this these those my your our their his her we they i ' +
    'not no very just like about into over under than then also plus per via')
    .split(' '),
);

export function isDangling(word: string): boolean {
  return DANGLING.has(word.toLowerCase().replace(/[^a-z']/g, ''));
}

// Deliberately small: these carry no topic signal, so leaving them in makes
// every pair of sentences look similar and washes out the shift detection.
const STOPWORDS = new Set(
  ('a an and are as at be been but by for from had has have he her his i if in is it its of on or she so that the their ' +
    'then there these they this to was we were what when which who will with you your our us not no yes just like know ' +
    'going get got do does did can could would should about here now one two also very really thing things kind sort')
    .split(' '),
);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Group words into sentences. Punctuation ends a sentence; so does a pause long
 * enough that the thought has clearly landed (whisper often omits terminal
 * punctuation in conversational speech, so pauses can't be ignored).
 */
export function buildSentences(words: Word[], pauseSec = 0.7, maxSec = 20): Sentence[] {
  const out: Sentence[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text).join(' ');
    out.push({ start: cur[0]!.start, end: cur[cur.length - 1]!.end, text, tokens: tokenize(text) });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    cur.push(w);
    const next = words[i + 1];
    const pause = next ? next.start - w.end : Infinity;
    const tooLong = w.end - cur[0]!.start >= maxSec;
    // Punctuation always ends a thought. A pause only ends one if the speaker
    // isn't left hanging on a conjunction or article — and `tooLong` is a
    // safety valve that must still fire, or a run-on never breaks.
    const pauseEnds = pause >= pauseSec && !isDangling(w.text);
    if (SENTENCE_END.test(w.text) || pauseEnds || tooLong) flush();
  }
  flush();
  return out;
}

/** Overlap of content vocabulary between two token bags (0..1). */
function cohesion(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let shared = 0;
  for (const t of new Set(a)) if (setB.has(t)) shared++;
  return shared / Math.sqrt(new Set(a).size * setB.size);
}

/**
 * Topic-shift boundaries, by lexical cohesion (a TextTiling-style measure).
 *
 * For each gap between sentences, compare the vocabulary of the `window`
 * sentences before it against the `window` after. A dip means the two sides are
 * talking about different things — the speaker has moved on, so a cut there
 * costs the least meaning. Deterministic and local: no model call, no latency
 * added to import.
 *
 * Returns indices i meaning "a topic starts at sentence i".
 */
export function topicBoundaries(sentences: Sentence[], window = 3): number[] {
  if (sentences.length < window * 2 + 1) return [];
  const scores: { i: number; score: number }[] = [];
  for (let i = window; i <= sentences.length - window; i++) {
    const before = sentences.slice(i - window, i).flatMap((s) => s.tokens);
    const after = sentences.slice(i, i + window).flatMap((s) => s.tokens);
    scores.push({ i, score: cohesion(before, after) });
  }
  if (!scores.length) return [];

  const mean = scores.reduce((a, s) => a + s.score, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((a, s) => a + (s.score - mean) ** 2, 0) / scores.length);
  // A boundary must be BOTH a local minimum and meaningfully below average,
  // otherwise gentle drift inside one topic gets marked as a shift.
  const threshold = mean - sd * 0.5;
  const picked: number[] = [];
  for (let k = 0; k < scores.length; k++) {
    const s = scores[k]!;
    const prev = scores[k - 1]?.score ?? Infinity;
    const next = scores[k + 1]?.score ?? Infinity;
    if (s.score <= threshold && s.score <= prev && s.score <= next) {
      // Don't emit two boundaries a sentence apart.
      if (!picked.length || s.i - picked[picked.length - 1]! >= window) picked.push(s.i);
    }
  }
  return picked;
}

/**
 * Move a boundary time off the middle of a word.
 *
 * A cut inside a word is always wrong, whatever put it there — scene detection,
 * an interval mark, anything. Returns the nearest instant where no word is
 * sounding, or null if there is no sane place nearby.
 */
export function snapOutOfWord(t: number, words: Word[], maxShiftSec = 1.5): number | null {
  const straddling = words.find((w) => t > w.start && t < w.end);
  if (!straddling) return t;
  const before = straddling.start;
  const after = straddling.end;
  const pick = t - before <= after - t ? before : after;
  return Math.abs(pick - t) <= maxShiftSec ? pick : null;
}

/** Is `t` inside a sentence (i.e. cutting there interrupts a thought)? */
export function insideSentence(t: number, sentences: Sentence[], edgeTolerance = 0.05): boolean {
  return sentences.some((s) => t > s.start + edgeTolerance && t < s.end - edgeTolerance);
}
