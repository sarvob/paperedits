/**
 * CLI-side preflight: the probing lives in @pve/import (shared with the desktop
 * shell); this module adds the terminal report + the mandatory startup gate.
 */
import { installHintFor, type PreflightReport } from '@pve/core';
import { runSystemChecks } from '@pve/import';

export { runSystemChecks };

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
    if (!l.ok && l.required) console.log(`      fix: ${installHintFor(l, thisPlatform())}`);
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
