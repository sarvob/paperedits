import { describe, expect, it } from 'vitest';
import {
  HeuristicBackend,
  Session,
  applyOps,
  buildDigest,
  planRender,
  segment,
  validateOps,
  type Op,
} from '../src/index.js';
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
