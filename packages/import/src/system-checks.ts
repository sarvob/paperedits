/**
 * Node probe adapter for the mandatory preflight. Lives here (not the CLI) so
 * every entry point — the terminal REPL and the Electron shell — shares one
 * implementation. Turns "is the binary there / what version" into ProbeResults
 * the pure evaluator in @pve/core consumes.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { evaluatePreflight, type PreflightReport, type ProbeResult } from '@pve/core';
import { findModel } from './transcribe.js';
import { hasDrawtext } from './render-exec.js';

const run = promisify(execFile);

async function tryVersion(bin: string, args: string[] = ['-version']): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 5000 });
    const first = (stdout || stderr).split('\n')[0]?.trim() ?? '';
    return { ok: true, detail: first || `${bin} present` };
  } catch {
    return { ok: false, detail: 'not found on PATH' };
  }
}

async function checkNode(): Promise<ProbeResult> {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? { ok: true, detail: `Node ${process.versions.node}` }
    : { ok: false, detail: `Node ${process.versions.node} (need ≥ 20)` };
}

async function checkWhisper(): Promise<ProbeResult> {
  const bin = process.env.PVE_WHISPER_BIN;
  const candidates = bin ? [bin] : ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];
  let foundBin = '';
  for (const c of candidates) {
    const res = await tryVersion(c, ['--help']).catch(() => ({ ok: false, detail: '' }));
    if (res.ok) {
      foundBin = c;
      break;
    }
  }
  if (!foundBin) return { ok: false, detail: 'whisper binary not found (set PVE_WHISPER_BIN)' };
  const model = findModel();
  if (!model) return { ok: false, detail: `binary ok (${foundBin}) but no model (set PVE_WHISPER_MODEL)` };
  return { ok: true, detail: `${foundBin} + model ${model.split('/').pop()}` };
}

async function checkEncoder(): Promise<ProbeResult> {
  try {
    const { stdout } = await run('ffmpeg', ['-hide_banner', '-encoders'], { timeout: 5000 });
    const hw = ['h264_videotoolbox', 'h264_nvenc', 'h264_qsv'].filter((e) => stdout.includes(e));
    return hw.length
      ? { ok: true, detail: hw.join(', ') }
      : { ok: false, detail: 'no hardware encoder; will use libx264 (slower)' };
  } catch {
    return { ok: false, detail: 'ffmpeg unavailable' };
  }
}

async function checkLabelBurn(): Promise<ProbeResult> {
  const ok = await hasDrawtext().catch(() => false);
  return ok
    ? { ok: true, detail: 'drawtext available' }
    : { ok: false, detail: 'ffmpeg built without libfreetype; labels not burned' };
}

/** Probe the machine and produce the pass/fail report. */
export async function runSystemChecks(): Promise<PreflightReport> {
  const [node, ffmpeg, ffprobe, whisper, encoder, labelburn] = await Promise.all([
    checkNode(),
    tryVersion('ffmpeg'),
    tryVersion('ffprobe'),
    checkWhisper(),
    checkEncoder(),
    checkLabelBurn(),
  ]);
  return evaluatePreflight({ node, ffmpeg, ffprobe, whisper, encoder, labelburn });
}
