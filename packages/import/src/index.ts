import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Analysis, AnalysisCache, Importer, ImportOptions, Word } from '@pve/core';
import { audioLevels, hasAudioStream, scanContainer } from './scan.js';
import { transcribe, type WhisperConfig } from './transcribe.js';
import { findVisionModel, visualPass } from './visual.js';

export { scanContainer, hasAudioStream, audioLevels } from './scan.js';
export { visualPass, findVisionModel } from './visual.js';
export { transcribe, findModel, DEFAULT_MODEL_NAMES } from './transcribe.js';
export { renderToFile, hasDrawtext, type RenderResult } from './render-exec.js';
export { runSystemChecks } from './system-checks.js';

/** Disk cache keyed by file hash, so re-import of a known file is instant. */
export class FileAnalysisCache implements AnalysisCache {
  constructor(private dir = '.pve-cache') {}
  private path(hash: string): string {
    return join(this.dir, `${hash}.json`);
  }
  async get(fileHash: string): Promise<Analysis | null> {
    const p = this.path(fileHash);
    if (!existsSync(p)) return null;
    return JSON.parse(await readFile(p, 'utf8')) as Analysis;
  }
  async put(analysis: Analysis): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path(analysis.fileHash), JSON.stringify(analysis));
  }
}

export interface FfmpegImporterConfig {
  whisper?: WhisperConfig;
  cache?: AnalysisCache;
}

/**
 * The M1 import pass. Container scan (ffprobe, no decode) for the activity curve
 * and scene cuts + local whisper.cpp transcription → a cached `Analysis`.
 *
 * NOTE: object detection and VLM captions (the sparse visual pass) are P1 — they
 * are left empty here. The engine handles empty detections/captions fine; you
 * lose object-based rules ("keep the drill parts") until that pass lands, not
 * core function.
 */
export class FfmpegImporter implements Importer {
  private cache: AnalysisCache;
  constructor(private cfg: FfmpegImporterConfig = {}) {
    this.cache = cfg.cache ?? new FileAnalysisCache();
  }

  /** SHA-256 of the file contents — the cache key for the whole pipeline. */
  hashFile(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      createReadStream(path)
        .on('data', (c) => hash.update(c))
        .on('end', () => resolve(hash.digest('hex').slice(0, 16)))
        .on('error', reject);
    });
  }

  async analyze(path: string, opts: ImportOptions = {}): Promise<Analysis> {
    const fileHash = await this.hashFile(path);

    const cached = await this.cache.get(fileHash);
    if (cached) {
      // Cache-upgrade: analyses imported before the visual pass existed have no
      // captions — run just that stage and re-save, instead of a full re-import.
      const upgraded = await this.maybeVisualPass(path, cached, opts);
      opts.onProgress?.('done', 100);
      return upgraded;
    }

    opts.onProgress?.('scan', 5);
    const scan = await scanContainer(path);

    // Screen recordings and silent clips have no audio stream — extracting audio
    // for whisper would fail, so detect and skip transcription cleanly.
    const audio = await hasAudioStream(path);
    let words: Word[] = [];
    let levels: number[] = [];
    if (audio) {
      opts.onProgress?.('transcribe', 30);
      // Loudness curve (fast) + transcript (slow) in parallel.
      [levels, words] = await Promise.all([audioLevels(path), transcribe(path, this.cfg.whisper)]);
    }

    let analysis: Analysis = {
      fileHash,
      durationSec: scan.durationSec,
      hasAudio: audio,
      words,
      audioLevels: levels,
      activityPerSec: scan.activityPerSec,
      sceneCuts: scan.sceneCuts,
      detections: [],
      captions: [],
    };

    analysis = await this.maybeVisualPass(path, analysis, opts);

    opts.onProgress?.('segment', 95);
    await this.cache.put(analysis);
    opts.onProgress?.('done', 100);
    return analysis;
  }

  /**
   * The sparse visual pass (local VLM keyframe captions). Skipped silently when
   * no vision model is installed; failures never block an import.
   */
  private async maybeVisualPass(path: string, analysis: Analysis, opts: ImportOptions): Promise<Analysis> {
    if (analysis.captions.length) return analysis; // already has vision
    try {
      const model = await findVisionModel();
      if (!model) return analysis;
      opts.onProgress?.('visual', 60);
      const vis = await visualPass(path, analysis.durationSec, analysis.sceneCuts, {
        model,
        maxFrames: opts.maxCaptions ?? 48,
        onProgress: (done, total) => opts.onProgress?.('visual', 60 + Math.round((done / total) * 30)),
      });
      const upgraded = { ...analysis, captions: vis.captions, detections: vis.detections };
      await this.cache.put(upgraded);
      return upgraded;
    } catch {
      return analysis;
    }
  }
}
