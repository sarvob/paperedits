import { stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import {
  overlayWindow,
  planRender,
  type Edl,
  type OverlayRenderSpec,
  type RenderOptions,
} from '@pve/core';
import { exec } from './exec.js';

/** Whether this ffmpeg build can burn text via drawtext (informational only —
 * overlays no longer depend on it, they composite pre-rendered PNGs). */
export async function hasDrawtext(): Promise<boolean> {
  const { stdout } = await exec('ffmpeg', ['-hide_banner', '-filters']).catch(() => ({ stdout: '' }));
  return /\bdrawtext\b/.test(stdout);
}

/** Probe the source video bitrate (bps) so "match source" can target it. */
async function sourceBitrate(input: string): Promise<number | null> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=bit_rate',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ]).catch(() => ({ stdout: '' }));
  const n = Number(stdout.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export interface RenderResult {
  output: string;
  bytes: number;
  seconds: number;
  command: string;
}

/**
 * Actually render an EDL to a file. The caller supplies a rasterized PNG for
 * each overlay id it wants composited (produced by the Electron renderer's
 * canvas — no ffmpeg text support required). Overlays whose id has no PNG are
 * skipped. Timing for each overlay is resolved from the EDL's output timeline.
 */
export async function renderToFile(
  edl: Edl,
  opts: Omit<RenderOptions, 'overlays'> & {
    /** overlayId → path to a transparent PNG of that overlay */
    overlayPngs?: Record<string, string>;
    onLog?: (line: string) => void;
    onWarn?: (line: string) => void;
  },
): Promise<RenderResult> {
  const overlayPngs = opts.overlayPngs ?? {};
  const overlays: OverlayRenderSpec[] = [];
  for (const ov of edl.overlays) {
    const png = overlayPngs[ov.id];
    if (!png || !existsSync(png)) continue;
    const win = overlayWindow(edl, ov);
    if (!win) continue;
    overlays.push({ png, xFrac: ov.x, yFrac: ov.y, start: win.start, end: win.end });
  }
  if (edl.overlays.length && overlays.length < edl.overlays.length) {
    opts.onWarn?.(`${edl.overlays.length - overlays.length} overlay(s) had no rasterized image and were skipped`);
  }

  const plan = planRender(edl, { ...opts, overlays });

  // Resolve quality: 'match' → probed source bitrate; otherwise the plan's flags.
  const args = [...plan.args];
  const bIdx = args.indexOf('copymatch');
  if (bIdx >= 0) {
    const br = await sourceBitrate(opts.input);
    if (br) args[bIdx] = `${Math.round(br)}`;
    else args.splice(bIdx - 1, 2);
  }

  const t0 = Date.now();
  const { stderr } = await exec('ffmpeg', args, { timeoutMs: 10 * 60_000 });
  opts.onLog?.(stderr.split('\n').slice(-2).join('\n'));

  const { size } = await stat(opts.output);
  return {
    output: opts.output,
    bytes: size,
    seconds: (Date.now() - t0) / 1000,
    command: `ffmpeg ${args.map((a) => (/\s/.test(a) ? `'${a}'` : a)).join(' ')}`,
  };
}
