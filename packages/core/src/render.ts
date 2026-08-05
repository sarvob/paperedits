import { outputDuration } from './edl.js';
import { mergedForRender } from './postprocess.js';
import type { Edl, SegmentEntry } from './types.js';

/**
 * One overlay to composite, already resolved to an on-disk PNG and an output-
 * time window. The engine stays pure: it only references the PNG path and never
 * rasterizes text itself. The caller (the Electron renderer via canvas, or any
 * HTML→PNG path) produces the images — so text/emoji rendering needs no ffmpeg
 * freetype support at all.
 */
export interface OverlayRenderSpec {
  png: string;
  /** centre position as a fraction of the frame, 0..1 */
  xFrac: number;
  yFrac: number;
  /** on-screen window on the OUTPUT timeline (seconds) */
  start: number;
  end: number;
}

export interface RenderOptions {
  input: string;
  output: string;
  /** "match source" is the default so a 300 MB input can't balloon to 1.8 GB */
  quality: 'match' | 'high' | 'draft';
  /** hardware encoder; chosen by platform at call time */
  encoder: 'videotoolbox' | 'nvenc' | 'qsv' | 'x264';
  /** overlay layer, composited over the cut via the `overlay` filter (no freetype) */
  overlays?: OverlayRenderSpec[];
  /** does the source have audio? false → render video-only (no atempo/loudnorm) */
  hasAudio?: boolean;
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
 * speed, atempo chain for audio, then concat. The overlay LAYER is composited on
 * top of the concatenated video with the `overlay` filter (each overlay a PNG,
 * shown only within its output-time window) — no drawtext / freetype needed.
 * Fast sections are muted rather than pitch-shifted into noise.
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
  const overlays = opts.overlays ?? [];
  const hasAudio = opts.hasAudio !== false;

  const vLabels: string[] = [];
  const aLabels: string[] = [];
  const filters: string[] = [];

  segs.forEach((s, i) => {
    const dur = (s.sourceEnd - s.sourceStart).toFixed(3);
    // Video: trim to source range, reset PTS, scale time by 1/speed.
    filters.push(
      `[0:v]trim=start=${s.sourceStart.toFixed(3)}:duration=${dur},setpts=(PTS-STARTPTS)/${s.speed}[v${i}]`,
    );
    vLabels.push(`[v${i}]`);

    if (hasAudio) {
      // Audio: ALWAYS atempo to the segment speed so its duration matches the
      // time-compressed video (otherwise concat pads to the longer stream). Very
      // fast or explicitly-muted sections additionally get volume=0 — silenced,
      // but still compressed to the right length.
      const muted = s.speed > 3 || s.audio === 'mute';
      filters.push(
        `[0:a]atrim=start=${s.sourceStart.toFixed(3)}:duration=${dur},asetpts=PTS-STARTPTS,${atempoChain(s.speed)}${muted ? ',volume=0' : ''}[a${i}]`,
      );
      aLabels.push(`[a${i}]`);
    }
  });

  const n = segs.length;
  const baseLabel = overlays.length ? '[basev]' : '[outv]';
  let concat: string;
  if (hasAudio) {
    // Streams INTERLEAVED per segment: [v0][a0][v1][a1]… — not all v then all a.
    const interleaved = vLabels.map((v, i) => `${v}${aLabels[i]}`).join('');
    concat = `${interleaved}concat=n=${n}:v=1:a=1${baseLabel}[araw]`;
  } else {
    // Video-only source (e.g. a screen recording): concat video only.
    concat = `${vLabels.join('')}concat=n=${n}:v=1:a=0${baseLabel}`;
  }

  // Overlay layer: chain one `overlay` per PNG, gated to its output-time window.
  // x/y centre the PNG at the requested frame fraction (W,H = main; w,h = overlay).
  const overlayFilters: string[] = [];
  let cur = '[basev]';
  overlays.forEach((ov, i) => {
    const inputIdx = i + 1; // 0 is the source video
    const out = i === overlays.length - 1 ? '[outv]' : `[ovc${i}]`;
    overlayFilters.push(
      `${cur}[${inputIdx}:v]overlay=x='W*${ov.xFrac.toFixed(4)}-w/2':y='H*${ov.yFrac.toFixed(4)}-h/2':` +
        `enable='between(t,${ov.start.toFixed(3)},${ov.end.toFixed(3)})'${out}`,
    );
    cur = out;
  });

  // Loudness-normalize inside the graph (only when there's audio).
  const audioChain = hasAudio ? [`[araw]loudnorm[outa]`] : [];
  const filterComplex = [...filters, concat, ...overlayFilters, ...audioChain].join(';');

  const qualityFlags =
    opts.quality === 'match'
      ? ['-b:v', 'copymatch'] // resolved to source bitrate by the caller at spawn time
      : opts.quality === 'high'
        ? ['-crf', '18']
        : ['-crf', '28'];

  const overlayInputs = overlays.flatMap((ov) => ['-i', ov.png]);
  const args = [
    '-y',
    '-i',
    opts.input,
    ...overlayInputs,
    '-filter_complex',
    filterComplex,
    '-map',
    '[outv]',
    ...(hasAudio ? ['-map', '[outa]'] : []),
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
