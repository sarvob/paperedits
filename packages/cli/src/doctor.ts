/**
 * `npm run doctor` — run the mandatory system check and report. Exit code is 0
 * when the machine is ready, 1 when a required dependency is missing, so it can
 * gate CI or a launcher script.
 */
import { printReport, runSystemChecks } from './system-checks.js';

const report = printReport(await runSystemChecks());
if (report.ok) {
  console.log('Ready. All required dependencies present.\n');
  process.exit(0);
} else {
  console.error(`Not ready: ${report.blocking.map((b) => b.name).join(', ')} missing.\n`);
  process.exit(1);
}
