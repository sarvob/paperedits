import type { Candidate, Digest, DigestEntry } from './types.js';

/**
 * Build the digest from candidates. This is the ONLY artifact permitted to
 * cross the network: text and numbers derived from the video, never frames or
 * audio. One entry per candidate, ~100–140 tokens each.
 */
export function buildDigest(fileHash: string, durationSec: number, candidates: Candidate[]): Digest {
  // Hesitation is relative to the SPEAKER, not an absolute scale: a naturally
  // disfluent talker would trip a fixed threshold on every segment, and a
  // polished one on none. Measured on a 30-min interview, a fixed 0.4 flagged
  // 30 of 65 segments (mean 0.36) — i.e. it flagged "average" as notable.
  // Flagging outliers against this video's own baseline keeps it meaningful.
  // Percentile, not mean+sd: a uniformly disfluent speaker saturates the score,
  // which collapses the standard deviation to ~0 and makes mean+sd flag either
  // everything or nothing. Taking the top fifth is stable under any
  // distribution shape, including that degenerate one.
  const scores = candidates.map((c) => c.markers?.hesitation ?? 0).sort((a, b) => a - b);
  const notable = scores.length ? (scores[Math.floor(scores.length * 0.8)] ?? 1) : 1;

  const entries: DigestEntry[] = candidates.map((c) => ({
    id: c.id,
    index: c.index,
    start: Number(c.start.toFixed(2)),
    end: Number(c.end.toFixed(2)),
    speech: c.speechPreview,
    activity: c.activity,
    objects: c.objects,
    ...(c.caption ? { caption: c.caption } : {}),
    // Only carry hesitation when it is actually notable. Emitting it for every
    // segment would add ~600 tokens to a 30-min digest to say "normal" 70 times.
    ...(c.markers && c.markers.hesitation > notable && c.markers.hesitation > 0
      ? { hesitation: c.markers.hesitation }
      : {}),
  }));
  return { fileHash, durationSec, entries };
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Render the digest to the compact text form that is actually sent to the model.
 * Kept deliberately terse; this is what the outbound-review pane displays.
 */
export function digestToPrompt(digest: Digest): string {
  const lines = digest.entries.map((e) => {
    const parts = [
      `#${e.index} [${e.id}] ${fmtTime(e.start)}-${fmtTime(e.end)}`,
      `act=${e.activity.toFixed(2)}`,
    ];
    if (e.objects.length) parts.push(`obj=${e.objects.join(',')}`);
    if (e.caption) parts.push(`cap="${e.caption}"`);
    // Surfaces HOW it was said — the speaker picked their words here.
    if (e.hesitation != null) parts.push(`hesitant=${e.hesitation.toFixed(2)}`);
    parts.push(`say="${e.speech}"`);
    return parts.join(' | ');
  });
  return lines.join('\n');
}

/** Rough token estimate (~4 chars/token) for cost display and budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
