import type { Analysis, Word } from './types.js';

/**
 * The import pass is the one part that touches native binaries (ffmpeg decode,
 * whisper.cpp, a small detector, a VLM). The core stays pure by depending only
 * on this interface; a concrete importer lives in a separate package and is
 * swapped in at runtime. Everything downstream consumes the cached `Analysis`.
 */
export interface Importer {
  /** content hash of a source file — the cache key for the whole pipeline */
  hashFile(path: string): Promise<string>;
  /** run (or load from cache) the full import pass for a file */
  analyze(path: string, opts?: ImportOptions): Promise<Analysis>;
}

export interface ImportOptions {
  whisperModel?: 'tiny' | 'base' | 'small';
  /** cap on VLM-captioned keyframes per file (budget guard) */
  maxCaptions?: number;
  onProgress?: (stage: ImportStage, pct: number) => void;
  /**
   * Fired when the background visual pass finishes AFTER analyze() returned —
   * the analysis now carries frame captions/detections and is re-cached. Lets
   * the app start editing on the transcript immediately and gain vision later.
   */
  onEnriched?: (analysis: Analysis) => void;
  /**
   * Fired during transcription as contiguous transcript accumulates (chunked
   * whisper only) — powers the progressive "summary within seconds" UX.
   */
  onPartialTranscript?: (words: Word[], coveredSec: number, totalSec: number) => void;
}

export type ImportStage = 'scan' | 'transcribe' | 'visual' | 'caption' | 'segment' | 'done';

/** A cache keyed by file hash so re-import of a known file is instant. */
export interface AnalysisCache {
  get(fileHash: string): Promise<Analysis | null>;
  put(analysis: Analysis): Promise<void>;
}
