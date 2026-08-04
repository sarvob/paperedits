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
import { FfmpegImporter, renderToFile } from '@pve/import';
import { sampleAnalysis } from './sample.js';
import { requireSystem } from './system-checks.js';

const VIDEO_EXT = /\.(mp4|mov|mkv|webm|m4v|avi)$/i;

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

async function loadAnalysis(): Promise<Analysis> {
  const arg = process.argv[2];
  if (arg && VIDEO_EXT.test(arg)) {
    console.log(`\nImporting ${arg} …`);
    const importer = new FfmpegImporter();
    const t0 = Date.now();
    const analysis = await importer.analyze(arg, {
      onProgress: (stage, pct) => process.stdout.write(`  ${stage} ${pct}%\r`),
    });
    console.log(`\n  imported in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `(${analysis.words.length} words, ${analysis.sceneCuts.length} scene cuts)`);
    return analysis;
  }
  if (arg && arg.endsWith('.json')) {
    console.log(`(loading analysis from ${arg})`);
    return JSON.parse(readFileSync(arg, 'utf8')) as Analysis;
  }
  console.log('(using built-in sample "build log" — pass a video file or Analysis JSON to use your own)');
  return sampleAnalysis();
}

async function main() {
  // Mandatory system check — the editor does not start until it passes. Engine
  // dev against the synthetic sample may opt into degraded mode explicitly.
  await requireSystem({ allowDegraded: process.env.PVE_DEV_SYNTHETIC === '1' });

  const session = new Session(await loadAnalysis());
  const backend = new HeuristicBackend();
  const sourceArg = process.argv[2];
  const sourcePath = sourceArg && VIDEO_EXT.test(sourceArg) ? sourceArg : null;

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
          console.log('  :edl :digest :render :export [file] :history :undo :redo :quit');
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
        case 'export': {
          if (!sourcePath) {
            console.log('   :export needs a real source video (launch with a video path)');
            break;
          }
          const out = line.split(/\s+/)[1] ?? sourcePath.replace(VIDEO_EXT, '.edit.mp4');
          console.log(`   rendering → ${out} …`);
          try {
            const r = await renderToFile(session.edl, {
              input: sourcePath,
              output: out,
              quality: 'match',
              encoder: 'videotoolbox',
              onWarn: (w) => console.log(`   ⚠️  ${w}`),
            });
            console.log(`   ✓ ${r.output} — ${(r.bytes / 1e6).toFixed(1)} MB in ${r.seconds.toFixed(1)}s`);
          } catch (e) {
            console.log(`   ✗ render failed: ${(e as Error).message.split('\n')[0]}`);
          }
          break;
        }
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
