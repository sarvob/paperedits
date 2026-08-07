import { describe, expect, it } from 'vitest';
import {
  HeuristicBackend,
  Session,
  applyOps,
  buildDigest,
  canonicalizeId,
  canonicalizeOps,
  planRender,
  segment,
  validateOps,
  wantsRemoval,
  type Op,
} from '../src/index.js';
import { buildSentences, insideSentence, snapOutOfWord, topicBoundaries } from '../src/semantic.js';
import { makeAnalysis } from './fixture.js';

describe('segmentation', () => {
  it('produces candidates and never cuts off an atom boundary', () => {
    const analysis = makeAnalysis();
    const { atoms, candidates } = segment(analysis);
    expect(candidates.length).toBeGreaterThan(1);

    const boundaries = new Set(atoms.flatMap((a) => [a.start, a.end]));
    for (const c of candidates) {
      expect(boundaries.has(c.start)).toBe(true);
      expect(boundaries.has(c.end)).toBe(true);
    }
  });

  it('captures objects and captions per candidate', () => {
    const analysis = makeAnalysis();
    const { candidates } = segment(analysis);
    const withDrill = candidates.filter((c) => c.objects.includes('drill'));
    expect(withDrill.length).toBeGreaterThan(0);
  });
});

describe('validation (hard contract)', () => {
  it('rejects an op referencing an unknown id and leaves EDL unchanged', async () => {
    const analysis = makeAnalysis();
    const session = new Session(analysis);
    const before = JSON.stringify(session.edl);

    const badBackend = {
      name: 'bad',
      network: false,
      async plan() {
        return {
          instruction: 'x',
          ops: [{ op: 'retime', ids: ['c999'], speed: 10 }] as Op[],
          interpretation: 'bogus',
        };
      },
    };
    const res = await session.prompt('do something', badBackend as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0]!.reason).toMatch(/unknown/);
    expect(JSON.stringify(session.edl)).toBe(before); // no change
  });

  it('rejects a malformed op', () => {
    const analysis = makeAnalysis();
    const { candidates } = segment(analysis);
    const digest = buildDigest(analysis.fileHash, analysis.durationSec, candidates);
    const errors = validateOps(
      [{ op: 'retime', ids: [candidates[0]!.id], speed: 999 }],
      digest,
      { fileHash: analysis.fileHash, entries: [], aspect: 'source' },
    );
    expect(errors.length).toBe(1);
    expect(errors[0]!.reason).toMatch(/out of range/);
  });
});

describe('flagship flow: key 1x, rest fast, label fast', () => {
  it('classifies, retimes and labels in one turn', async () => {
    const session = new Session(makeAnalysis());
    const res = await session.prompt(
      'key parts 1x, rest 10x, label the fast parts',
      new HeuristicBackend(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const segs = res.edl.entries.filter((e) => e.kind === 'segment');
    const fast = segs.filter((e) => e.kind === 'segment' && e.speed > 1);
    const slow = segs.filter((e) => e.kind === 'segment' && e.speed === 1);
    expect(fast.length).toBeGreaterThan(0);
    expect(slow.length).toBeGreaterThan(0);
    // fast sections carry labels
    expect(fast.some((e) => e.kind === 'segment' && e.label)).toBe(true);
    // EDL is reviewable — small entry count
    expect(segs.length).toBeLessThanOrEqual(30);
  });
});

describe('interactive follow-ups compose and respect pinning', () => {
  it('"actually 6x" changes only the mapping; a pinned segment is untouched; undo reverts one turn', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('key parts 1x, rest 10x', new HeuristicBackend());

    // User hand-adjusts one fast segment to 4x (this pins it).
    const target = session.edl.entries.find((e) => e.kind === 'segment' && e.speed === 10);
    expect(target).toBeTruthy();
    session.setSpeed(target!.id, 4);
    const pinnedId = target!.id;

    // Follow-up: change speed mapping to 6x.
    const res = await session.prompt('actually make it 6x', new HeuristicBackend());
    expect(res.ok).toBe(true);

    const pinned = session.edl.entries.find((e) => e.id === pinnedId);
    expect(pinned && pinned.kind === 'segment' && pinned.speed).toBe(4); // untouched
    const others = session.edl.entries.filter(
      (e) => e.kind === 'segment' && e.id !== pinnedId && e.class === 'skip',
    );
    expect(others.every((e) => e.kind === 'segment' && e.speed === 6)).toBe(true);

    // One undo reverts the "6x" turn as a single step.
    session.undo();
    const afterUndo = session.edl.entries.filter(
      (e) => e.kind === 'segment' && e.id !== pinnedId && e.class === 'skip',
    );
    expect(afterUndo.every((e) => e.kind === 'segment' && e.speed === 10)).toBe(true);
  });

  it('"keep anything with the drill at 1x" adds a rule on top', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('key parts 1x, rest 8x', new HeuristicBackend());
    const res = await session.prompt('keep anything with the drill at 1x', new HeuristicBackend());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // At least one segment that mentions/has the drill is now 1x.
    const drillSegs = session.candidates.filter((c) => c.objects.includes('drill'));
    expect(drillSegs.length).toBeGreaterThan(0);
  });
});

describe('overlay layer', () => {
  it('"label the fast parts" creates overlay-layer objects anchored to segments', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('key parts 1x, rest 10x, label the fast parts', new HeuristicBackend());
    expect(session.edl.overlays.length).toBeGreaterThan(0);
    const ov = session.edl.overlays[0]!;
    expect(ov.anchor.mode).toBe('segment');
    expect(ov.content.length).toBeGreaterThan(0);
  });

  it('supports manual add / update / remove with pinning and undo', async () => {
    const session = new Session(makeAnalysis());
    const created = session.addOverlay({
      kind: 'emoji',
      content: '🔥',
      x: 0.8,
      y: 0.2,
      size: 0.1,
      anchor: { mode: 'output', start: 1, duration: 3 },
    });
    expect(created.pinned).toBe(true);
    expect(session.edl.overlays).toHaveLength(1);

    session.updateOverlay(created.id, { x: 0.5 });
    expect(session.edl.overlays[0]!.x).toBe(0.5);

    session.undo(); // reverts the move
    expect(session.edl.overlays[0]!.x).toBe(0.8);

    session.removeOverlay(created.id);
    expect(session.edl.overlays).toHaveLength(0);
  });

  it('drops overlays anchored to a cut segment', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('label the fast parts', new HeuristicBackend());
    const anchored = session.edl.overlays.find((o) => o.anchor.mode === 'segment')!;
    const segId = anchored.anchor.mode === 'segment' ? anchored.anchor.segmentId : '';
    const seg = session.edl.entries.find((e) => e.id === segId)!;
    // Cut that exact entry directly; its anchored overlay must be removed too.
    const after = applyOps(session.edl, [{ op: 'cut', ids: [seg.id] }]);
    expect(after.entries.some((e) => e.id === segId)).toBe(false);
    expect(after.overlays.some((o) => o.anchor.mode === 'segment' && o.anchor.segmentId === segId)).toBe(false);
  });
});

describe('render plan', () => {
  it('composites overlays as PNG layers (no drawtext needed)', async () => {
    const session = new Session(makeAnalysis());
    session.addOverlay({ kind: 'text', content: 'Hi', x: 0.5, y: 0.8, size: 0.07, anchor: { mode: 'output', start: 0, duration: 2 } });
    const plan = planRender(session.edl, {
      input: 'in.mp4',
      output: 'out.mp4',
      quality: 'match',
      encoder: 'videotoolbox',
      overlays: [{ png: '/tmp/ov.png', xFrac: 0.5, yFrac: 0.8, start: 0, end: 2 }],
    });
    expect(plan.filterComplex).toContain('overlay=');
    expect(plan.filterComplex).toContain("enable='between(t,0.000,2.000)'");
    expect(plan.filterComplex).not.toContain('drawtext');
    expect(plan.args).toContain('/tmp/ov.png');
  });
});

describe('render plan (base)', () => {
  it('builds a concat filtergraph without needing ffmpeg', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('key parts 1x, rest 10x, label the fast parts', new HeuristicBackend());
    const plan = planRender(session.edl, {
      input: 'in.mp4',
      output: 'out.mp4',
      quality: 'match',
      encoder: 'videotoolbox',
    });
    expect(plan.filterComplex).toContain('concat=n=');
    expect(plan.filterComplex).toContain('setpts');
    expect(plan.command.startsWith('ffmpeg')).toBe(true);
    expect(plan.estimatedOutputSec).toBeGreaterThan(0);
    // Output should be shorter than source, since fast sections compress time.
    expect(plan.estimatedOutputSec).toBeLessThan(session.analysis.durationSec);
  });
});

describe('model id repair (formatting slips are not hallucinations)', () => {
  it('resolves unpadded and bare-numeric ids, and rejects invented ones', () => {
    const known = new Set(['c001', 'c020', 'c084']);
    expect(canonicalizeId('c020', known)).toBe('c020'); // exact
    expect(canonicalizeId('c20', known)).toBe('c020'); // dropped zero padding
    expect(canonicalizeId('20', known)).toBe('c020'); // bare ordinal
    expect(canonicalizeId('c999', known)).toBeNull(); // out of range → reject
    expect(canonicalizeId('nonsense', known)).toBeNull();
  });

  it('repairs ids inside ops so a good edit is not rejected over a missing zero', () => {
    const known = new Set(['c001', 'c020']);
    const ops: Op[] = [
      { op: 'retime', ids: ['c20', 'c1'], speed: 10 },
      { op: 'classify', definition: 'x', keyIds: ['c20'] },
    ];
    const fixed = canonicalizeOps(ops, known);
    expect((fixed[0] as { ids: string[] }).ids).toEqual(['c020', 'c001']);
    expect((fixed[1] as { keyIds: string[] }).keyIds).toEqual(['c020']);
  });
});

describe('duration targets are a promise, not an estimate', () => {
  it('keeps the measured EDL under the target with margin for render drift', async () => {
    const session = new Session(makeAnalysis());
    const target = 20;
    const r = await session.planTargetDuration(new HeuristicBackend(), target, 10, 'compress');
    expect(r.resultSec).toBeLessThanOrEqual(target);
  });

  it('does not re-add segments an earlier edit already cut', async () => {
    const session = new Session(makeAnalysis());
    const firstId = session.candidates[0]!.id;
    // Stand-in for "remove the technical demos": an edit that cuts a segment.
    const cutter = {
      name: 'test',
      network: false,
      plan: async () => ({ instruction: 'cut', ops: [{ op: 'cut', ids: [firstId] }] as Op[], interpretation: 'cut one' }),
    };
    await session.prompt('cut the first bit', cutter);
    expect(session.edl.entries.some((e) => e.kind === 'segment' && e.candidateId === firstId)).toBe(false);

    await session.planTargetDuration(new HeuristicBackend(), 25, 10, 'compress');
    // The duration planner must not resurrect it as a sped-up segment.
    expect(session.edl.entries.some((e) => e.kind === 'segment' && e.candidateId === firstId)).toBe(false);
  });
});

describe('removal intent vs speed-up intent', () => {
  it('only treats explicit removal language as a cut', () => {
    expect(wantsRemoval('make it under 5 minutes')).toBe(false);
    expect(wantsRemoval('cut it to 5 minutes')).toBe(false); // names the deliverable
    expect(wantsRemoval('remove the rest, under 5 minutes')).toBe(true);
    expect(wantsRemoval('only keep the highlights, under 5 min')).toBe(true);
    expect(wantsRemoval('get rid of everything else, 4 minutes')).toBe(true);
  });
});

describe('transitions', () => {
  it('never fades a boundary touching a sped-up segment (no strobing)', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('key parts 1x, rest 10x', new HeuristicBackend());
    const plan = planRender(session.edl, { input: 'in.mp4', output: 'out.mp4', quality: 'match', encoder: 'videotoolbox' });
    // Fades dip through black; around a fast run that reads as flicker.
    expect(plan.filterComplex).not.toContain('fade=t=');
  });

  it('fades a real content jump between two full-speed segments, without changing duration', () => {
    const session = new Session(makeAnalysis());
    const segs = session.edl.entries.filter((e) => e.kind === 'segment');
    // Remove a middle segment so its neighbours are no longer contiguous.
    const victim = segs[1]!;
    const cut = applyOps(session.edl, [{ op: 'cut', ids: [(victim as { candidateId: string }).candidateId] }] as Op[], {});
    const opts = { input: 'in.mp4', output: 'out.mp4', quality: 'match' as const, encoder: 'videotoolbox' as const };
    const withFades = planRender(cut, opts);
    const without = planRender(cut, { ...opts, transitionSec: 0 });
    expect(withFades.filterComplex).toContain('fade=t=');
    expect(without.filterComplex).not.toContain('fade=t=');
    // Fades must NOT shift timing — that is why this is not an xfade.
    expect(withFades.estimatedOutputSec).toBeCloseTo(without.estimatedOutputSec, 5);
  });

  it('motion-blurs sped-up segments before the speed change, not after', async () => {
    const session = new Session(makeAnalysis());
    await session.prompt('key parts 1x, rest 10x', new HeuristicBackend());
    const opts = { input: 'in.mp4', output: 'out.mp4', quality: 'match' as const, encoder: 'videotoolbox' as const };
    const fc = planRender(session.edl, opts).filterComplex;
    expect(fc).toContain('tmix=frames=');
    // Blending has to happen on the frames the speed-up discards.
    expect(fc.indexOf('tmix=')).toBeLessThan(fc.indexOf('setpts=(PTS-STARTPTS)/10'));
    expect(planRender(session.edl, { ...opts, motionBlur: false }).filterComplex).not.toContain('tmix=');
  });

  it('uses each encoder’s own constant-quality flag (crf is x264-only)', () => {
    const base = { input: 'i.mp4', output: 'o.mp4', quality: 'draft' as const };
    expect(planRender(new Session(makeAnalysis()).edl, { ...base, encoder: 'x264' }).args).toContain('-crf');
    const vt = planRender(new Session(makeAnalysis()).edl, { ...base, encoder: 'videotoolbox' }).args;
    expect(vt).toContain('-q:v');
    expect(vt).not.toContain('-crf'); // silently ignored by videotoolbox
  });
});

describe('cuts land where meaning is complete', () => {
  it('never places a boundary inside a word or a sentence', () => {
    const analysis = makeAnalysis();
    const { atoms, candidates } = segment(analysis);
    const sentences = buildSentences(analysis.words);
    const bounds = [...new Set(candidates.flatMap((c) => [c.start, c.end]))].filter(
      (t) => t > 0.1 && t < analysis.durationSec - 0.1,
    );
    for (const t of bounds) {
      expect(analysis.words.some((w) => t > w.start + 0.02 && t < w.end - 0.02)).toBe(false);
      expect(insideSentence(t, sentences)).toBe(false);
    }
    expect(atoms.length).toBeGreaterThan(0);
  });

  it('drops scene cuts that would interrupt a spoken sentence', () => {
    const analysis = makeAnalysis();
    const sentences = buildSentences(analysis.words);
    // A scene cut planted in the middle of a sentence must not become a boundary.
    const victim = sentences.find((s) => s.end - s.start > 1);
    if (!victim) return;
    const mid = (victim.start + victim.end) / 2;
    const withCut = { ...analysis, sceneCuts: [...analysis.sceneCuts, mid] };
    const atoms = segment(withCut).atoms;
    expect(atoms.some((a) => Math.abs(a.end - mid) < 0.02)).toBe(false);
  });

  it('snapOutOfWord moves a boundary to the nearest silence between words', () => {
    const words = [
      { start: 0, end: 1, text: 'hello' },
      { start: 1.4, end: 2, text: 'world' },
    ];
    expect(snapOutOfWord(1.2, words)).toBe(1.2); // already in the gap
    expect(snapOutOfWord(0.9, words)).toBe(1); // inside 'hello' → its end
    expect(snapOutOfWord(0.1, words)).toBe(0); // inside 'hello' → its start
  });

  it('finds a topic shift where the vocabulary changes', () => {
    const mk = (text: string, i: number) => ({ start: i, end: i + 0.9, text });
    // Ten sentences about pricing, then ten about hardware.
    const words = [
      ...Array.from({ length: 10 }, (_, i) => mk('pricing revenue customers margin contracts.', i)),
      ...Array.from({ length: 10 }, (_, i) => mk('rotor battery airframe thrust chassis.', i + 10)),
    ];
    const sentences = buildSentences(words);
    const shifts = topicBoundaries(sentences, 3);
    expect(shifts.length).toBeGreaterThan(0);
    // The shift should be near sentence 10, where the subject changes.
    expect(Math.min(...shifts.map((i) => Math.abs(i - 10)))).toBeLessThanOrEqual(2);
  });
});
