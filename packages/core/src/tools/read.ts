import type { Analysis, Candidate, Digest, Edl } from '../types.js';

/**
 * Read-only query tools. These let the agent start from a slim summary and
 * fetch only what an instruction needs (lazy digest) instead of receiving the
 * full digest every turn. Results are digest-derived text only — never frames
 * or audio — but in remote mode they DO cross the wire, so the outbound-review
 * pane must show the full loop transcript, not just the first payload.
 */
export class ReadTools {
  constructor(
    private readonly analysis: Analysis,
    private readonly candidates: Candidate[],
    private readonly digest: Digest,
    private getEdl: () => Edl,
  ) {}

  /** Full detail for one candidate (more than the digest line carries). */
  get_segment_detail(id: string): Candidate | { error: string } {
    const c = this.candidates.find((x) => x.id === id || `e_${x.id}` === id);
    return c ?? { error: `no candidate ${id}` };
  }

  /** Substring/word search over the transcript; returns matching candidate ids. */
  search_transcript(query: string): { id: string; index: number; at: number; snippet: string }[] {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const hits: { id: string; index: number; at: number; snippet: string }[] = [];
    for (const c of this.candidates) {
      const idx = c.speechPreview.toLowerCase().indexOf(q);
      if (idx >= 0) {
        hits.push({ id: c.id, index: c.index, at: c.start, snippet: c.speechPreview });
        continue;
      }
      // Fall back to the full transcript span for words beyond the preview.
      const span = this.analysis.words
        .filter((w) => w.start >= c.start && w.start < c.end)
        .map((w) => w.text)
        .join(' ');
      if (span.toLowerCase().includes(q)) {
        hits.push({ id: c.id, index: c.index, at: c.start, snippet: span.slice(0, 120) });
      }
    }
    return hits;
  }

  /** Current EDL as the agent would see it (blocks + labels + speeds). */
  get_current_edl(): Edl {
    return this.getEdl();
  }

  /** Mean activity over a time range, for "keep the busy parts" style asks. */
  get_activity(range: { start: number; end: number }): { start: number; end: number; activity: number } {
    const lo = Math.max(0, Math.floor(range.start));
    const hi = Math.min(this.analysis.activityPerSec.length, Math.ceil(range.end));
    let sum = 0;
    let n = 0;
    for (let s = lo; s < hi; s++) {
      sum += this.analysis.activityPerSec[s] ?? 0;
      n++;
    }
    return { start: range.start, end: range.end, activity: n ? Number((sum / n).toFixed(3)) : 0 };
  }
}
