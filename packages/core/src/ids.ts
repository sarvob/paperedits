import type { Op } from './types.js';

/**
 * Repair a segment id emitted by a model into one the engine actually knows.
 *
 * Small models reliably drop zero-padding ("c20" for "c020") or emit the bare
 * ordinal ("20"). Those are formatting slips, not hallucinations: the model
 * picked a real segment and wrote its name wrong. Silently discarding them
 * throws away correct judgement — measured on a 30-min video, 4 of 5 ranked
 * highlights were being dropped this way.
 *
 * A genuinely invented id (out of range, non-numeric) still returns null so the
 * validator can reject it and leave the EDL untouched.
 */
export function canonicalizeId(raw: string, known: Set<string>): string | null {
  if (known.has(raw)) return raw;
  const m = /(\d+)\s*$/.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  // Try the canonical zero-padded widths before giving up.
  for (const width of [3, 2, 4, 1]) {
    const candidate = `c${String(n).padStart(width, '0')}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

/** Canonicalize every id an op carries; unresolvable ids are left as-is so
 *  the validator still rejects them (never silently dropped). */
export function canonicalizeOps(ops: Op[], known: Set<string>): Op[] {
  const fix = (id: string) => canonicalizeId(id, known) ?? id;
  return ops.map((op) => {
    if ('ids' in op && Array.isArray(op.ids)) return { ...op, ids: op.ids.map(fix) };
    if (op.op === 'classify') return { ...op, keyIds: op.keyIds.map(fix) };
    if (op.op === 'insert') return { ...op, beforeId: fix(op.beforeId) };
    return op;
  });
}
