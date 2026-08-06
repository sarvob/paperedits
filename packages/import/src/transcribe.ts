import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Word } from '@pve/core';
import { exec } from './exec.js';

export interface WhisperConfig {
  /** whisper.cpp CLI binary; default resolves whisper-cli / PVE_WHISPER_BIN */
  bin?: string;
  /** ggml model path; default PVE_WHISPER_MODEL */
  model?: string;
  onProgress?: (pct: number) => void;
  /**
   * Fired as contiguous transcript becomes available (chunked mode only):
   * `words` is everything transcribed from 0..coveredSec so far. Enables
   * progressive summaries long before the full transcript exists.
   */
  onPartial?: (words: Word[], coveredSec: number, totalSec: number) => void;
}

function resolveBin(cfg: WhisperConfig): string {
  return cfg.bin ?? process.env.PVE_WHISPER_BIN ?? 'whisper-cli';
}
/** Default model filenames searched under any `models/` dir up the tree. */
export const DEFAULT_MODEL_NAMES = ['ggml-base.en.bin', 'ggml-base.bin'];

/**
 * Resolve a usable model path from config → env → a `models/` directory found by
 * walking up from cwd (so it works regardless of which workspace package the
 * process was launched from). Returns null if nothing usable is found.
 */
export function findModel(cfg: WhisperConfig = {}): string | null {
  const explicit = cfg.model ?? process.env.PVE_WHISPER_MODEL;
  if (explicit && existsSync(explicit)) return explicit;

  let dir = process.cwd();
  for (;;) {
    for (const name of DEFAULT_MODEL_NAMES) {
      const p = join(dir, 'models', name);
      if (existsSync(p)) return p;
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function resolveModel(cfg: WhisperConfig): string {
  const m = findModel(cfg);
  if (!m) {
    throw new Error(
      'no whisper model — set PVE_WHISPER_MODEL to a ggml model path ' +
        '(e.g. models/ggml-base.en.bin)',
    );
  }
  return m;
}

/** Extract 16 kHz mono PCM WAV — exactly what whisper.cpp expects. */
async function extractAudio(input: string, wavOut: string): Promise<void> {
  await exec('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wavOut]);
}

/** whisper.cpp JSON shape (with --output-json). */
interface WhisperJson {
  transcription: { offsets: { from: number; to: number }; text: string }[];
}

/** Run whisper-cli on one wav file; returns words with LOCAL timestamps. */
async function runWhisper(bin: string, model: string, wav: string, outBase: string): Promise<Word[]> {
  await exec(bin, [
    '-m', model,
    '-f', wav,
    '--max-len', '1',
    '--split-on-word',
    '--output-json',
    '--output-file', outBase,
    '--no-prints',
  ]);
  const json = JSON.parse(await readFile(`${outBase}.json`, 'utf8')) as WhisperJson;
  const words: Word[] = [];
  for (const seg of json.transcription ?? []) {
    const text = seg.text.trim();
    if (!text) continue;
    words.push({ text, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 });
  }
  return words;
}

/** WAV duration from the 16k mono s16le byte size (32000 bytes/sec + header). */
async function wavDuration(wav: string): Promise<number> {
  const { size } = await import('node:fs/promises').then((fs) => fs.stat(wav));
  return Math.max(0, (size - 44) / 32000);
}

/** Chunking parameters: small first chunk (fast first partial), then 8-minute
 * strides; 2s head-overlap; ≤3 concurrent procs. */
const FIRST_CHUNK = 120;
const STRIDE = 480;
const OVERLAP = 2;
const CONCURRENCY = 3;
const PARALLEL_THRESHOLD = 240; // below 4 min, one process is simpler & fine

/** Chunk boundaries: [0..FIRST_CHUNK], then STRIDE-sized, clamped to duration. */
function chunkPlan(dur: number): { start: number; len: number; end: number; i: number }[] {
  const bounds: number[] = [0, Math.min(FIRST_CHUNK, dur)];
  while (bounds[bounds.length - 1]! < dur) {
    bounds.push(Math.min(bounds[bounds.length - 1]! + STRIDE, dur));
  }
  const chunks: { start: number; len: number; end: number; i: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const start = Math.max(0, bounds[i]! - (i > 0 ? OVERLAP : 0));
    chunks.push({ start, len: bounds[i + 1]! - start, end: bounds[i + 1]!, i });
  }
  return chunks;
}

/**
 * Transcribe to word-level `Word[]`. Long files are split into 8-minute chunks
 * transcribed by CONCURRENT whisper processes (≈2-3× wall-clock on multi-core),
 * then merged: each chunk after the first starts OVERLAP seconds early, and
 * words falling inside that head-overlap are dropped (the previous chunk owns
 * them), so seams never duplicate or truncate words.
 */
export async function transcribe(input: string, cfg: WhisperConfig = {}): Promise<Word[]> {
  const bin = resolveBin(cfg);
  const model = resolveModel(cfg);
  const dir = await mkdtemp(join(tmpdir(), 'pve-whisper-'));
  const wav = join(dir, 'audio.wav');

  try {
    await extractAudio(input, wav);
    const dur = await wavDuration(wav);

    if (dur <= PARALLEL_THRESHOLD) {
      return await runWhisper(bin, model, wav, join(dir, 'out'));
    }

    // Cut chunk wavs (stream-copy, near-instant), then run a small worker pool.
    const plan = chunkPlan(dur);
    const chunks: { start: number; end: number; wav: string; out: string }[] = [];
    for (const c of plan) {
      const cwav = join(dir, `c${c.i}.wav`);
      await exec('ffmpeg', ['-y', '-ss', String(c.start), '-t', String(c.len), '-i', wav, '-c', 'copy', cwav]);
      chunks.push({ start: c.start, end: c.end, wav: cwav, out: join(dir, `o${c.i}`) });
    }

    const results: Word[][] = new Array(chunks.length);
    let next = 0;
    let done = 0;
    let emitted = 0;
    // Emit contiguous-prefix partials in order, even when chunks finish out of
    // order. The final chunk doesn't emit — the full return covers it.
    const tryEmitPartial = () => {
      let advanced = false;
      while (emitted < chunks.length && results[emitted]) {
        emitted++;
        advanced = true;
      }
      if (advanced && emitted < chunks.length) {
        cfg.onPartial?.(results.slice(0, emitted).flat(), chunks[emitted - 1]!.end, dur);
      }
    };
    const worker = async () => {
      for (;;) {
        const i = next++;
        if (i >= chunks.length) return;
        const c = chunks[i]!;
        const local = await runWhisper(bin, model, c.wav, c.out);
        results[i] = local
          .filter((w) => i === 0 || w.start >= OVERLAP) // head-overlap belongs to prev chunk
          .map((w) => ({ text: w.text, start: w.start + c.start, end: w.end + c.start }));
        done++;
        cfg.onProgress?.(Math.round((done / chunks.length) * 100));
        tryEmitPartial();
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    return results.flat().sort((a, b) => a.start - b.start);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
