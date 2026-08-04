import type { Analysis } from '@pve/core';

/**
 * A synthetic 2-minute "build log" so the demo and REPL need no media file.
 * Three regimes: busy intro (drill), quiet exposition, busy build. Speech is
 * laid across the full duration so segmentation tells a coherent story.
 */
export function sampleAnalysis(): Analysis {
  const words: { text: string; start: number; end: number }[] = [];
  const say = (line: string, from: number, to: number) => {
    const toks = line.split(' ');
    const step = (to - from) / toks.length;
    toks.forEach((w, i) => words.push({ text: w, start: from + i * step, end: from + i * step + step * 0.7 }));
  };
  say('Today we are wiring the motor with the drill and it is loud.', 1, 14);
  say('Let me show the bracket mount before we continue along here.', 16, 29);
  say('Now I will talk through the theory for a while without doing much.', 31, 52);
  say('This part is mostly background and honestly not that interesting to watch.', 54, 73);
  say('Okay back to building, drilling the final holes and mounting it all.', 77, 98);
  say('And that is the finished assembly, thanks for watching this build log.', 100, 118);

  const durationSec = 120;
  return {
    fileHash: 'samplehash',
    durationSec,
    words,
    activityPerSec: Array.from({ length: durationSec }, (_, s) => (s < 30 || s >= 75 ? 0.8 : 0.1)),
    sceneCuts: [30, 75],
    detections: [
      { at: 5, labels: ['drill', 'motor'] },
      { at: 82, labels: ['drill'] },
      { at: 110, labels: ['assembly'] },
    ],
    captions: [
      { at: 5, text: 'a person holding a drill near a motor' },
      { at: 50, text: 'a person talking to the camera' },
      { at: 100, text: 'a completed assembly' },
    ],
  };
}
