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

/** Chunking parameters: 8-minute chunks, 2s head-overlap, ≤3 concurrent procs. */
const STRIDE = 480;
const OVERLAP = 2;
const CONCURRENCY = 3;
const PARALLEL_THRESHOLD = 600; // below 10 min, one process is simpler & fine

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
    const chunks: { start: number; wav: string; out: string }[] = [];
    for (let i = 0; i * STRIDE < dur; i++) {
      const start = Math.max(0, i * STRIDE - (i > 0 ? OVERLAP : 0));
      const len = STRIDE + (i > 0 ? OVERLAP : 0);
      const cwav = join(dir, `c${i}.wav`);
      await exec('ffmpeg', ['-y', '-ss', String(start), '-t', String(len), '-i', wav, '-c', 'copy', cwav]);
      chunks.push({ start, wav: cwav, out: join(dir, `o${i}`) });
    }

    const results: Word[][] = new Array(chunks.length);
    let next = 0;
    let done = 0;
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
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));
    return results.flat().sort((a, b) => a.start - b.start);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
