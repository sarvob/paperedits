import { describe, expect, it } from 'vitest';
import { REQUIREMENTS, evaluatePreflight, installHintFor } from '../src/index.js';

const allPass = Object.fromEntries(REQUIREMENTS.map((r) => [r.id, { ok: true, detail: 'ok' }]));

describe('preflight evaluation', () => {
  it('passes only when every required item passes', () => {
    expect(evaluatePreflight(allPass).ok).toBe(true);
  });

  it('blocks when a required item is missing and lists it', () => {
    const probed = { ...allPass, ffmpeg: { ok: false, detail: 'not found' } };
    const report = evaluatePreflight(probed);
    expect(report.ok).toBe(false);
    expect(report.blocking.map((b) => b.id)).toContain('ffmpeg');
  });

  it('does NOT block when only an optional item is missing', () => {
    const probed = { ...allPass, encoder: { ok: false, detail: 'no hw encoder' } };
    const report = evaluatePreflight(probed);
    expect(report.ok).toBe(true);
    expect(report.blocking).toHaveLength(0);
  });

  it('fails closed for an unprobed requirement', () => {
    const report = evaluatePreflight({}); // nothing probed
    expect(report.ok).toBe(false);
    expect(report.blocking.length).toBeGreaterThan(0);
  });

  it('gives a platform-specific install hint', () => {
    const line = evaluatePreflight({}).lines.find((l) => l.id === 'ffmpeg')!;
    expect(installHintFor(line, 'darwin')).toContain('brew');
    expect(installHintFor(line, 'win32')).toContain('winget');
  });
});
