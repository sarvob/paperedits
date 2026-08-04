/**
 * Mandatory system preflight. A local-first video editor shells out to native
 * binaries (ffmpeg to decode/encode, whisper.cpp to transcribe); if they are
 * missing the app must refuse to start rather than fail deep in a pipeline.
 *
 * This module owns the *definitions* and the *evaluation* (both pure and
 * testable). The actual probing (spawning `ffmpeg -version`, etc.) is a
 * platform adapter supplied by the host — the Node CLI today, a Tauri/Electron
 * shell later — so every entry point shares one source of truth about what the
 * system needs.
 */

export type Platform = 'darwin' | 'linux' | 'win32';

export interface Requirement {
  id: string;
  name: string;
  /** why the product needs it, shown in the report */
  why: string;
  /** true = the app must not run without it; false = degraded-but-usable */
  required: boolean;
  /** per-platform install hint shown when the check fails */
  installHint: Partial<Record<Platform, string>> & { default: string };
}

/**
 * The canonical requirement list. `required: true` items are hard gates. Whisper
 * is required because transcription is on the critical path for import; the LLM
 * backends are NOT here — they are optional and chosen in settings.
 */
export const REQUIREMENTS: Requirement[] = [
  {
    id: 'node',
    name: 'Node.js ≥ 20',
    why: 'runtime for the engine and tooling',
    required: true,
    installHint: { default: 'Install Node 20+ from https://nodejs.org' },
  },
  {
    id: 'ffmpeg',
    name: 'ffmpeg',
    why: 'decode, retime, burn labels, and the single export encode',
    required: true,
    installHint: {
      darwin: 'brew install ffmpeg',
      linux: 'sudo apt install ffmpeg  (or your distro equivalent)',
      win32: 'winget install Gyan.FFmpeg',
      default: 'Install ffmpeg from https://ffmpeg.org/download.html',
    },
  },
  {
    id: 'ffprobe',
    name: 'ffprobe',
    why: 'container scan for the activity curve and scene-cut candidates',
    required: true,
    installHint: {
      darwin: 'brew install ffmpeg  (ships ffprobe)',
      default: 'Ships with ffmpeg — install ffmpeg',
    },
  },
  {
    id: 'whisper',
    name: 'whisper.cpp + a model',
    why: 'local, word-level transcription (nothing leaves the machine)',
    required: true,
    installHint: {
      darwin:
        'brew install whisper-cpp, then download a model, e.g.\n' +
        '      whisper-cpp-download-ggml-model base.en\n' +
        '      export PVE_WHISPER_MODEL=/path/to/ggml-base.en.bin',
      default:
        'Build whisper.cpp (https://github.com/ggerganov/whisper.cpp), download a\n' +
        '      ggml model, and set PVE_WHISPER_BIN / PVE_WHISPER_MODEL',
    },
  },
  {
    id: 'encoder',
    name: 'hardware video encoder',
    why: 'fast export (VideoToolbox / NVENC / QSV); falls back to libx264',
    required: false,
    installHint: { default: 'Optional — software x264 is used if unavailable' },
  },
  {
    id: 'labelburn',
    name: 'text label burn (drawtext)',
    why: 'burn segment labels into the video; without it labels stay in the EDL only',
    required: false,
    installHint: {
      darwin: 'Install an ffmpeg built with libfreetype (e.g. brew ffmpeg with freetype)',
      default: 'Rebuild/install ffmpeg with --enable-libfreetype',
    },
  },
];

/** Result of probing one requirement on this machine. */
export interface ProbeResult {
  ok: boolean;
  /** human detail, e.g. the detected version or "not found on PATH" */
  detail: string;
}

export interface CheckLine extends Requirement, ProbeResult {}

export interface PreflightReport {
  /** true only when every REQUIRED requirement passed */
  ok: boolean;
  lines: CheckLine[];
  /** required requirements that failed — the reason the app is blocked */
  blocking: CheckLine[];
}

/**
 * Combine requirement definitions with probe results into a pass/fail report.
 * A missing probe result counts as a failure (fail-closed). Pure — no I/O.
 */
export function evaluatePreflight(probed: Record<string, ProbeResult>): PreflightReport {
  const lines: CheckLine[] = REQUIREMENTS.map((req) => {
    const p = probed[req.id] ?? { ok: false, detail: 'not checked' };
    return { ...req, ok: p.ok, detail: p.detail };
  });
  const blocking = lines.filter((l) => l.required && !l.ok);
  return { ok: blocking.length === 0, lines, blocking };
}

/** Pick the platform-appropriate install hint for a failed check. */
export function installHintFor(line: CheckLine, platform: Platform): string {
  return line.installHint[platform] ?? line.installHint.default;
}
