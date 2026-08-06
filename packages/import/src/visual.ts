import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Caption, Detection } from '@pve/core';
import { exec } from './exec.js';

/**
 * The sparse visual pass: caption keyframes with a small local VLM so the
 * digest knows what's ON SCREEN, not just what was said. Runs once per import
 * (background-tolerant), entirely local via Ollama.
 */

export interface VisualPassConfig {
  /** Ollama host; default local */
  host?: string;
  /** VLM model name; auto-detected from installed models when omitted */
  model?: string;
  /** cap on captioned keyframes per video (time budget guard) */
  maxFrames?: number;
  onProgress?: (done: number, total: number) => void;
}

const VLM_PREFS = ['moondream', 'llava', 'qwen2-vl', 'qwen2.5vl', 'minicpm-v'];

/** Find an installed vision-capable Ollama model, or null. */
export async function findVisionModel(host = 'http://127.0.0.1:11434'): Promise<string | null> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name: string }[] };
    const names = (data.models ?? []).map((m) => m.name);
    for (const p of VLM_PREFS) {
      const hit = names.find((n) => n.startsWith(p));
      if (hit) return hit;
    }
    return null;
  } catch {
    return null;
  }
}

/** Pick keyframe timestamps: every scene cut, then uniform fill up to maxFrames. */
export function pickKeyframeTimes(durationSec: number, sceneCuts: number[], maxFrames: number): number[] {
  const times = new Set<number>();
  for (const c of sceneCuts) times.add(Math.min(Math.max(0.5, c + 0.5), durationSec - 0.5));
  const uniform = Math.max(1, Math.floor(durationSec / Math.max(1, maxFrames)));
  for (let t = uniform / 2; t < durationSec && times.size < maxFrames; t += uniform) times.add(Math.round(t * 10) / 10);
  return [...times].sort((a, b) => a - b).slice(0, maxFrames);
}

async function extractFrame(input: string, at: number, out: string): Promise<void> {
  await exec('ffmpeg', ['-y', '-ss', at.toFixed(2), '-i', input, '-frames:v', '1', '-vf', 'scale=512:-2', '-q:v', '5', out]);
}

async function captionFrame(host: string, model: string, imageB64: string): Promise<{ caption: string; objects: string[] }> {
  const res = await fetch(`${host}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0 },
      // Moondream-class models caption best with a plain ask; structured
      // multi-part prompts degrade them (measured). Objects, when present,
      // arrive naturally inside the caption text and LLMs match on it there.
      prompt: 'Describe this video frame in one short sentence.',
      images: [imageB64],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`vlm returned ${res.status}`);
  const data = (await res.json()) as { response?: string };
  const text = (data.response ?? '').trim();
  const objLine = text.match(/OBJECTS:\s*(.+)/i);
  const caption = text.split(/OBJECTS:/i)[0]!.trim().replace(/\s+/g, ' ').slice(0, 160);
  const objects = objLine
    ? objLine[1]!
        .split(/[,;]/)
        .map((s) => s.trim().toLowerCase().replace(/\.$/, ''))
        .filter((s) => s && s.length < 32)
        .slice(0, 4)
    : [];
  return { caption, objects };
}

/**
 * Run the visual pass over a video: returns captions + detections keyed by
 * timestamp, ready to merge into the Analysis. Throws only if no VLM exists;
 * per-frame failures are skipped.
 */
export async function visualPass(
  input: string,
  durationSec: number,
  sceneCuts: number[],
  cfg: VisualPassConfig = {},
): Promise<{ captions: Caption[]; detections: Detection[]; model: string }> {
  const host = (cfg.host ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
  const model = cfg.model ?? (await findVisionModel(host));
  if (!model) throw new Error('no vision model installed (e.g. `ollama pull moondream`)');

  const times = pickKeyframeTimes(durationSec, sceneCuts, cfg.maxFrames ?? 48);
  const dir = await mkdtemp(join(tmpdir(), 'pve-frames-'));
  const captions: Caption[] = [];
  const detections: Detection[] = [];
  try {
    let done = 0;
    for (const at of times) {
      const frame = join(dir, `f${done}.jpg`);
      try {
        await extractFrame(input, at, frame);
        const b64 = (await readFile(frame)).toString('base64');
        const { caption, objects } = await captionFrame(host, model, b64);
        if (caption) captions.push({ at, text: caption });
        if (objects.length) detections.push({ at, labels: objects });
      } catch {
        /* skip bad frame; keep going */
      }
      done++;
      cfg.onProgress?.(done, times.length);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { captions, detections, model };
}
