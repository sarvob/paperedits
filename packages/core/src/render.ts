import { outputDuration } from './edl.js';
import { mergedForRender } from './postprocess.js';
import type { Edl, SegmentEntry } from './types.js';

export interface RenderOptions {
  input: string;
  output: string;
  /** "match source" is the default so a 300 MB input can't balloon to 1.8 GB */
  quality: 'match' | 'high' | 'draft';
  /** hardware encoder; chosen by platform at call time */
  encoder: 'videotoolbox' | 'nvenc' | 'qsv' | 'x264';
  /** font for burned labels (drawtext needs an explicit file on macOS) */
  fontFile?: string;
  /**
   * Burn segment labels into the video with drawtext. Requires an ffmpeg built
   * with libfreetype. Set false to skip burning (labels still exist in the EDL
   * and chapter export) when the filter is unavailable.
   */
  burnLabels?: boolean;
}

export const DEFAULT_RENDER: Omit<RenderOptions, 'input' | 'output'> = {
  quality: 'match',
  encoder: 'videotoolbox',
};

interface PlannedSegment {
  sourceStart: number;
  sourceEnd: number;
  speed: number;
  label?: string;
}

/**
 * A structured, inspectable render plan. Building it does NOT require ffmpeg;
 * running `command` does. This separation is what lets us unit-test the render
 * path with zero native deps.
 */
export interface RenderPlan {
  segments: PlannedSegment[];
  cards: { text: string; durationSec: number }[];
  estimatedOutputSec: number;
  /** the ffmpeg filter graph (setpts/atempo/label burn per segment) */
  filterComplex: string;
  /** the full argv, ready to spawn */
  args: string[];
  /** the same as a copy-pasteable shell line */
  command: string;
}

const encoderFlags: Record<RenderOptions['encoder'], string[]> = {
  videotoolbox: ['-c:v', 'h264_videotoolbox'],
  nvenc: ['-c:v', 'h264_nvenc'],
  qsv: ['-c:v', 'h264_qsv'],
  x264: ['-c:v', 'libx264'],
};

/** atempo only accepts [0.5,2.0]; chain factors to hit arbitrary speeds. */
function atempoChain(speed: number): string {
  let s = speed;
  const parts: string[] = [];
  while (s > 2.0) {
    parts.push('atempo=2.0');
    s /= 2.0;
  }
  while (s < 0.5) {
    parts.push('atempo=0.5');
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(4)}`);
  return parts.join(',');
}

/**
 * Build the single-encode render plan. Per-segment: trim, setpts for video
 * speed, atempo chain for audio, then concat. Labels burn as drawtext. Fast
 * sections at very high speed are muted rather than pitch-shifted into noise.
 */
export function planRender(edl: Edl, opts: RenderOptions): RenderPlan {
  // Collapse contiguous identical slices here (render-time only) so the filter
  // graph has one trim/setpts chain per distinct block, not per candidate.
  const merged = mergedForRender(edl);
  const segs = merged.entries.filter((e): e is SegmentEntry => e.kind === 'segment');
  const cards = edl.entries.filter((e) => e.kind === 'card').map((e) => ({
    text: e.kind === 'card' ? e.text : '',
    durationSec: e.kind === 'card' ? e.durationSec : 0,
  }));

  const vLabels: string[] = [];
  const aLabels: string[] = [];
  const filters: string[] = [];

  segs.forEach((s, i) => {
    const dur = (s.sourceEnd - s.sourceStart).toFixed(3);
    const v = `v${i}`;
    const a = `a${i}`;
    // Video: trim to source range, reset PTS, scale time by 1/speed.
    let vChain = `[0:v]trim=start=${s.sourceStart.toFixed(3)}:duration=${dur},setpts=(PTS-STARTPTS)/${s.speed}`;
    if (s.label && opts.burnLabels !== false) {
      // Inside a single-quoted drawtext value, colons are literal; the only char
      // that breaks the parser is the ASCII apostrophe (it closes the quote).
      // Swap it for the typographic ’ and strip backslashes. `expansion=none`
      // stops drawtext from interpreting %{...} sequences in the label.
      const safe = s.label.replace(/'/g, '’').replace(/\\/g, '');
      const font = opts.fontFile ? `fontfile='${opts.fontFile}':` : '';
      vChain += `,drawtext=${font}text='${safe}':expansion=none:x=(w-tw)/2:y=h-th-40:fontsize=42:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=12`;
    }
    filters.push(`${vChain}[${v}]`);
    vLabels.push(`[${v}]`);

    // Audio: ALWAYS atempo to the segment speed so its duration matches the
    // time-compressed video (otherwise concat pads to the longer stream). Very
    // fast or explicitly-muted sections additionally get volume=0 — silenced,
    // but still compressed to the right length.
    const muted = s.speed > 3 || s.audio === 'mute';
    filters.push(
      `[0:a]atrim=start=${s.sourceStart.toFixed(3)}:duration=${dur},asetpts=PTS-STARTPTS,${atempoChain(s.speed)}${muted ? ',volume=0' : ''}[${a}]`,
    );
    aLabels.push(`[${a}]`);
  });

  const n = segs.length;
  // concat requires streams INTERLEAVED per segment: [v0][a0][v1][a1]… — not all
  // videos then all audios. Then normalize loudness INSIDE the graph, since a
  // simple `-af loudnorm` cannot attach to a complex-filtergraph output.
  const interleaved = vLabels.map((v, i) => `${v}${aLabels[i]}`).join('');
  const concat = `${interleaved}concat=n=${n}:v=1:a=1[outv][araw]`;
  const loudnorm = `[araw]loudnorm[outa]`;
  const filterComplex = [...filters, concat, loudnorm].join(';');

  const qualityFlags =
    opts.quality === 'match'
      ? ['-b:v', 'copymatch'] // resolved to source bitrate by the caller at spawn time
      : opts.quality === 'high'
        ? ['-crf', '18']
        : ['-crf', '28'];

  const args = [
    '-y',
    '-i',
    opts.input,
    '-filter_complex',
    filterComplex,
    '-map',
    '[outv]',
    '-map',
    '[outa]',
    ...encoderFlags[opts.encoder],
    ...qualityFlags,
    opts.output,
  ];

  return {
    segments: segs.map((s) => ({
      sourceStart: s.sourceStart,
      sourceEnd: s.sourceEnd,
      speed: s.speed,
      ...(s.label ? { label: s.label } : {}),
    })),
    cards,
    estimatedOutputSec: Number(outputDuration(edl).toFixed(2)),
    filterComplex,
    args,
    command: `ffmpeg ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`,
  };
}

/** Export a YouTube-style chapter list from labels + output timing. */
export function exportChapters(edl: Edl): string {
  const lines: string[] = [];
  let t = 0;
  for (const e of edl.entries) {
    if (e.kind === 'card') {
      lines.push(`${fmt(t)} ${e.text}`);
      t += e.durationSec;
    } else if (e.class === 'key' && e.label) {
      lines.push(`${fmt(t)} ${e.label}`);
      t += (e.sourceEnd - e.sourceStart) / e.speed;
    } else {
      t += (e.sourceEnd - e.sourceStart) / e.speed;
    }
  }
  return lines.join('\n');
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
