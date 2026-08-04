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

/**
 * Transcribe to word-level `Word[]`. We pass `--max-len 1 --split-on-word` so
 * each JSON segment is a single word with millisecond offsets — the timing
 * granularity the segmentation pass needs for silence/sentence boundaries.
 */
export async function transcribe(input: string, cfg: WhisperConfig = {}): Promise<Word[]> {
  const bin = resolveBin(cfg);
  const model = resolveModel(cfg);
  const dir = await mkdtemp(join(tmpdir(), 'pve-whisper-'));
  const wav = join(dir, 'audio.wav');
  const outBase = join(dir, 'out');

  try {
    await extractAudio(input, wav);
    await exec(bin, [
      '-m', model,
      '-f', wav,
      '--max-len', '1',
      '--split-on-word',
      '--output-json',
      '--output-file', outBase,
      '--no-prints',
    ]);

    const raw = await readFile(`${outBase}.json`, 'utf8');
    const json = JSON.parse(raw) as WhisperJson;
    const words: Word[] = [];
    for (const seg of json.transcription ?? []) {
      const text = seg.text.trim();
      if (!text) continue;
      words.push({ text, start: seg.offsets.from / 1000, end: seg.offsets.to / 1000 });
    }
    return words;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
