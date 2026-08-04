import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { planRender, type Edl, type RenderOptions } from '@pve/core';
import { exec } from './exec.js';

/** Candidate system fonts for burned labels (drawtext needs a real file). */
const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/Library/Fonts/Arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
];

function pickFont(): string | undefined {
  return FONT_CANDIDATES.find((f) => existsSync(f));
}

/** Whether this ffmpeg build can burn text (needs libfreetype → drawtext). */
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
 * Actually render an EDL to a file. Builds the plan from @pve/core, resolves the
 * "match source" placeholder to the probed source bitrate, injects a system
 * font for label burn, then spawns the single ffmpeg encode.
 */
export async function renderToFile(
  edl: Edl,
  opts: Omit<RenderOptions, 'fontFile' | 'burnLabels'> & {
    onLog?: (line: string) => void;
    onWarn?: (line: string) => void;
  },
): Promise<RenderResult> {
  const fontFile = pickFont();
  // Degrade gracefully if this ffmpeg lacks drawtext (no libfreetype): render the
  // speed-ramped cut without burned labels rather than failing outright.
  const burnLabels = await hasDrawtext();
  const hasLabels = edl.entries.some((e) => e.kind === 'segment' && e.label);
  if (!burnLabels && hasLabels) {
    opts.onWarn?.(
      'ffmpeg has no drawtext filter (built without libfreetype) — rendering ' +
        'without burned labels. Labels remain in the EDL and chapter export.',
    );
  }
  const plan = planRender(edl, { ...opts, fontFile, burnLabels });

  // Resolve quality: 'match' → probed source bitrate; otherwise the plan's flags.
  const args = [...plan.args];
  const bIdx = args.indexOf('copymatch');
  if (bIdx >= 0) {
    const br = await sourceBitrate(opts.input);
    if (br) {
      args[bIdx] = `${Math.round(br)}`;
    } else {
      // No probeable bitrate — drop the -b:v flag pair and let the encoder pick.
      args.splice(bIdx - 1, 2);
    }
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
