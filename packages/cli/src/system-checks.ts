/**
 * Node probe adapter for the mandatory preflight. Spawns the native binaries
 * and turns "is it there / what version" into ProbeResults the pure evaluator
 * in @pve/core consumes. A future desktop shell provides its own adapter but
 * reuses the same requirement definitions and evaluation.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  evaluatePreflight,
  installHintFor,
  type PreflightReport,
  type ProbeResult,
} from '@pve/core';
import { findModel, hasDrawtext } from '@pve/import';

const run = promisify(execFile);

async function tryVersion(bin: string, args: string[] = ['-version']): Promise<ProbeResult> {
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 5000 });
    const first = (stdout || stderr).split('\n')[0]?.trim() ?? '';
    return { ok: true, detail: first || `${bin} present` };
  } catch {
    return { ok: false, detail: `not found on PATH` };
  }
}

async function checkNode(): Promise<ProbeResult> {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 20
    ? { ok: true, detail: `Node ${process.versions.node}` }
    : { ok: false, detail: `Node ${process.versions.node} (need ≥ 20)` };
}

async function checkWhisper(): Promise<ProbeResult> {
  // Accept an explicit binary path, or the common whisper.cpp entry points.
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

  // Reuse the importer's resolver (env → models/ dir up the tree).
  const model = findModel();
  if (!model) {
    return { ok: false, detail: `binary ok (${foundBin}) but no model (set PVE_WHISPER_MODEL)` };
  }
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

const thisPlatform = (): 'darwin' | 'linux' | 'win32' =>
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';

/** Print the report as a readable checklist. Returns the report unchanged. */
export function printReport(report: PreflightReport): PreflightReport {
  console.log('\nSystem check');
  console.log('────────────');
  for (const l of report.lines) {
    const mark = l.ok ? '✓' : l.required ? '✗' : '○';
    const tag = l.required ? '' : ' (optional)';
    console.log(`  ${mark} ${l.name}${tag} — ${l.detail}`);
    if (!l.ok) console.log(`      → ${l.why}`);
    if (!l.ok && l.required) {
      console.log(`      fix: ${installHintFor(l, thisPlatform())}`);
    }
  }
  console.log('');
  return report;
}

/**
 * The mandatory gate. Runs the checks, prints the report, and — unless the
 * caller allows degraded/synthetic mode — EXITS before any editing can start
 * when a required dependency is missing.
 */
export async function requireSystem(opts: { allowDegraded?: boolean } = {}): Promise<PreflightReport> {
  const report = printReport(await runSystemChecks());
  if (!report.ok && !opts.allowDegraded) {
    console.error(
      `Blocked: ${report.blocking.length} required dependency(ies) missing. ` +
        `Install the item(s) above, then re-run.\n` +
        `(For engine-only development against synthetic data, set PVE_DEV_SYNTHETIC=1.)`,
    );
    process.exit(1);
  }
  if (!report.ok && opts.allowDegraded) {
    console.warn('⚠️  Running in DEGRADED/synthetic mode — real media import is unavailable.\n');
  }
  return report;
}
