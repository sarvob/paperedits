import type { Candidate, Digest, DigestEntry } from './types.js';

/**
 * Build the digest from candidates. This is the ONLY artifact permitted to
 * cross the network: text and numbers derived from the video, never frames or
 * audio. One entry per candidate, ~100–140 tokens each.
 */
export function buildDigest(fileHash: string, durationSec: number, candidates: Candidate[]): Digest {
  const entries: DigestEntry[] = candidates.map((c) => ({
    id: c.id,
    index: c.index,
    start: Number(c.start.toFixed(2)),
    end: Number(c.end.toFixed(2)),
    speech: c.speechPreview,
    activity: c.activity,
    objects: c.objects,
    ...(c.caption ? { caption: c.caption } : {}),
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
    parts.push(`say="${e.speech}"`);
    return parts.join(' | ');
  });
  return lines.join('\n');
}

/** Rough token estimate (~4 chars/token) for cost display and budgeting. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
