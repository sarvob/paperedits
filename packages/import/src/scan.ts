import { exec } from './exec.js';

export interface ContainerScan {
  durationSec: number;
  activityPerSec: number[];
  sceneCuts: number[];
}

/** Media duration (seconds) from the container format header. */
async function probeDuration(input: string): Promise<number> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    input,
  ]);
  return Number(stdout.trim()) || 0;
}

/**
 * Per-second activity curve from video packet sizes — no decode. Larger packets
 * mean more bits spent, i.e. more motion/visual change. Summed per second and
 * normalized to [0,1]. Completes in ~1s for a 30-min file (spec budget).
 */
async function activityFromPackets(input: string, durationSec: number): Promise<number[]> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'packet=pts_time,size',
    '-of', 'csv=p=0',
    input,
  ]);

  const buckets = new Array(Math.max(1, Math.ceil(durationSec))).fill(0);
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const [ptsRaw, sizeRaw] = line.split(',');
    const pts = Number(ptsRaw);
    const size = Number(sizeRaw);
    if (!Number.isFinite(pts) || !Number.isFinite(size)) continue;
    const sec = Math.floor(pts);
    if (sec >= 0 && sec < buckets.length) buckets[sec] += size;
  }
  const max = Math.max(1, ...buckets);
  return buckets.map((b) => Number((b / max).toFixed(3)));
}

/**
 * Scene-cut candidate times via ffmpeg's scene-score filter. This decodes, but
 * only to compare successive frames; we take timestamps where the score crosses
 * a threshold. (P1 will move this to the sparse visual pass.)
 */
async function sceneCuts(input: string): Promise<number[]> {
  // showinfo prints lines like: pts_time:12.345 ... on selected (scene) frames.
  const { stderr } = await exec('ffmpeg', [
    '-i', input,
    '-filter:v', "select='gt(scene,0.4)',showinfo",
    '-an', '-f', 'null', '-',
  ]).catch((e: Error) => ({ stderr: e.message, stdout: '' }));

  const cuts: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t)) cuts.push(Number(t.toFixed(2)));
  }
  return [...new Set(cuts)].sort((a, b) => a - b);
}

export async function scanContainer(input: string): Promise<ContainerScan> {
  const durationSec = await probeDuration(input);
  const [activityPerSec, cuts] = await Promise.all([
    activityFromPackets(input, durationSec),
    sceneCuts(input),
  ]);
  return { durationSec, activityPerSec, sceneCuts: cuts };
}
