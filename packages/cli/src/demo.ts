/**
 * End-to-end demo of the interactive editing loop in HEURISTIC mode — no LLM,
 * no network, no ffmpeg. It builds a synthetic analysis, then drives the same
 * Session the desktop app would, printing the EDL after each instruction.
 *
 *   npm run demo
 */
import { HeuristicBackend, Session, digestToPrompt, estimateTokens, planRender, type Edl } from '@pve/core';
import { sampleAnalysis } from './sample.js';
import { requireSystem } from './system-checks.js';

function printEdl(edl: Edl): void {
  for (const e of edl.entries) {
    if (e.kind === 'card') {
      console.log(`   [CARD ${e.durationSec}s] "${e.text}"`);
    } else {
      const bar = e.class === 'key' ? '🟢' : '⚡';
      const label = e.label ? `  «${e.label}»` : '';
      const pin = e.pinned ? ' 📌' : '';
      console.log(
        `   ${bar} #${e.index} ${e.candidateId}  ${fmt(e.sourceStart)}-${fmt(e.sourceEnd)}  ${e.speed}×${label}${pin}`,
      );
    }
  }
}
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

async function main() {
  // The demo runs on a synthetic clip, so it opts into degraded mode — but the
  // system check still runs and reports, exactly as the real app gate does.
  await requireSystem({ allowDegraded: true });

  const session = new Session(sampleAnalysis());
  const backend = new HeuristicBackend();

  console.log('\n=== DIGEST (the only thing that would ever cross the network) ===');
  const digestText = digestToPrompt(session.digest);
  console.log(digestText);
  console.log(`\n(${session.digest.entries.length} segments · ~${estimateTokens(digestText)} tokens)\n`);

  const script = [
    'key parts 1x, rest 10x, label the fast parts',
    'actually make it 6x',
    'keep anything with the drill at 1x',
    'add a title saying "Motor Build" before segment 1',
  ];

  for (const instruction of script) {
    console.log(`\n>>> "${instruction}"`);
    const res = await session.prompt(instruction, backend);
    if (!res.ok) {
      console.log(`   ✗ rejected: ${res.errors.map((e) => e.reason).join('; ')}`);
      continue;
    }
    console.log(`   interpreted as: ${res.interpretation}`);
    printEdl(res.edl);
  }

  console.log('\n=== UNDO (one Ctrl-Z reverts the last prompt turn) ===');
  const undone = session.undo();
  console.log(`   undid: "${undone}"`);

  console.log('\n=== RENDER PLAN (built with zero ffmpeg; run it to encode) ===');
  const plan = planRender(session.edl, {
    input: 'build-log.mp4',
    output: 'build-log.edit.mp4',
    quality: 'match',
    encoder: 'videotoolbox',
  });
  console.log(`   source 120s → output ~${plan.estimatedOutputSec}s`);
  console.log(`   ${plan.command.slice(0, 160)}…`);

  console.log('\n=== HISTORY ===');
  console.log('   ' + session.timeline().join('  →  '));
  console.log('');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
