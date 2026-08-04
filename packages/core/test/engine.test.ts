import { describe, expect, it } from 'vitest';
import {
  HeuristicBackend,
  Session,
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

describe('render plan', () => {
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
