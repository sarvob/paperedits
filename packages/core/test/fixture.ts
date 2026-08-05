import type { Analysis, Word } from '../src/types.js';

/**
 * A synthetic 120-second analysis with three "regimes": a busy intro (drill),
 * a quiet talking stretch, and a busy build section. No real media required —
 * this exercises the whole engine deterministically.
 */
export function makeAnalysis(): Analysis {
  const words: Word[] = [];
  let t = 0;
  const say = (text: string, dur = 0.4, gapAfter = 0.05) => {
    words.push({ text, start: t, end: t + dur });
    t += dur + gapAfter;
  };
  const pause = (s: number) => {
    t += s;
  };

  // 0–30s: intro, high activity, drill present
  'Today we are wiring the motor with the drill and it is loud.'.split(' ').forEach((w) => say(w));
  pause(1.2); // silence boundary
  'Let me show you the bracket mount before we continue further along.'.split(' ').forEach((w) => say(w));
  pause(1.5);

  // 30–75s: quiet exposition, low activity
  'Now I will just talk through the theory for a while without doing much.'.split(' ').forEach((w) => say(w));
  pause(1.0);
  'This part is mostly background and honestly not very interesting to watch.'.split(' ').forEach((w) => say(w));
  pause(1.4);

  // 75–120s: build section, high activity
  'Okay back to building, drilling the final holes and mounting everything now.'.split(' ').forEach((w) => say(w));
  pause(1.1);
  'And that is the finished assembly, thanks for watching this build log.'.split(' ').forEach((w) => say(w));

  const durationSec = 120;

  // Per-second activity: high 0–30, low 30–75, high 75–120.
  const activityPerSec = Array.from({ length: durationSec }, (_, s) => {
    if (s < 30) return 0.8;
    if (s < 75) return 0.1;
    return 0.75;
  });

  return {
    fileHash: 'testhash123',
    durationSec,
    hasAudio: true,
    words,
    activityPerSec,
    sceneCuts: [30, 75],
    detections: [
      { at: 5, labels: ['drill', 'person'] },
      { at: 80, labels: ['drill', 'screwdriver'] },
      { at: 110, labels: ['assembly'] },
    ],
    captions: [
      { at: 5, text: 'a person holding a drill near a motor' },
      { at: 50, text: 'a person talking to the camera' },
      { at: 100, text: 'a completed mechanical assembly' },
    ],
  };
}
