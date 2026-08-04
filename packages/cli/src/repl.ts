/**
 * Interactive tester for the editing engine. Type instructions in natural
 * language and watch the EDL update live — the same Session the desktop app
 * drives, in HEURISTIC mode (no LLM, no network, no ffmpeg).
 *
 *   npm run repl                 # uses the built-in sample "build log"
 *   npm run repl -- clip.json    # or load an Analysis JSON you provide
 *
 * Meta commands:
 *   :edl        show the current edit
 *   :digest     show the text that would cross the network
 *   :render     show the ffmpeg render plan
 *   :history    show the undo timeline
 *   :undo :redo step through history
 *   :help :quit
 */
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import {
  HeuristicBackend,
  Session,
  digestToPrompt,
  estimateTokens,
  planRender,
  type Analysis,
  type Edl,
} from '@pve/core';
import { sampleAnalysis } from './sample.js';

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function printEdl(edl: Edl): void {
  if (!edl.entries.length) {
    console.log('   (empty)');
    return;
  }
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

function loadAnalysis(): Analysis {
  const arg = process.argv[2];
  if (arg && !arg.startsWith(':')) {
    console.log(`(loading analysis from ${arg})`);
    return JSON.parse(readFileSync(arg, 'utf8')) as Analysis;
  }
  console.log('(using built-in sample "build log" — pass an Analysis JSON path to use your own)');
  return sampleAnalysis();
}

async function main() {
  const session = new Session(loadAnalysis());
  const backend = new HeuristicBackend();

  console.log(`\nImported: ${session.digest.entries.length} segments, ${Math.round(session.analysis.durationSec)}s`);
  console.log('Type an instruction, or :help for commands. Ctrl-C to quit.\n');
  printEdl(session.edl);

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '\n▸ ' });
  rl.prompt();

  for await (const lineRaw of rl) {
    const line = lineRaw.trim();
    if (!line) {
      rl.prompt();
      continue;
    }

    if (line.startsWith(':')) {
      const [cmd] = line.slice(1).split(/\s+/);
      switch (cmd) {
        case 'quit':
        case 'q':
          rl.close();
          continue;
        case 'help':
          console.log('  instructions: e.g. "key parts 1x, rest 10x, label the fast parts"');
          console.log('  :edl :digest :render :history :undo :redo :quit');
          break;
        case 'edl':
          printEdl(session.edl);
          break;
        case 'digest': {
          const t = digestToPrompt(session.digest);
          console.log(t);
          console.log(`(${session.digest.entries.length} segments · ~${estimateTokens(t)} tokens)`);
          break;
        }
        case 'render': {
          const plan = planRender(session.edl, {
            input: 'clip.mp4',
            output: 'clip.edit.mp4',
            quality: 'match',
            encoder: 'videotoolbox',
          });
          console.log(`   source ${Math.round(session.analysis.durationSec)}s → output ~${plan.estimatedOutputSec}s`);
          console.log('   ' + plan.command);
          break;
        }
        case 'history':
          console.log('   ' + session.timeline().join('  →  '));
          break;
        case 'undo': {
          const u = session.undo();
          console.log(u ? `   undid: "${u}"` : '   nothing to undo');
          printEdl(session.edl);
          break;
        }
        case 'redo': {
          const r = session.redo();
          console.log(r ? `   redid: "${r}"` : '   nothing to redo');
          printEdl(session.edl);
          break;
        }
        default:
          console.log(`   unknown command :${cmd} (try :help)`);
      }
      rl.prompt();
      continue;
    }

    // Treat the line as an editing instruction.
    const res = await session.prompt(line, backend);
    if (!res.ok) {
      console.log(`   ✗ rejected: ${res.errors.map((e) => e.reason).join('; ')}`);
    } else {
      console.log(`   interpreted: ${res.interpretation}`);
      printEdl(res.edl);
    }
    rl.prompt();
  }

  console.log('\nbye.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
