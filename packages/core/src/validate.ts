import type { Digest, Edl, MutatingOp, Op, ValidationError } from './types.js';

const MAX_SPEED = 100;
const MIN_SPEED = 0.25;

/**
 * The hard contract: the model returns candidate IDs, never timestamps. Any ID
 * not present in the digest (or as an EDL entry) → reject the op. A malformed op
 * → reject. A model response must never be able to corrupt an edit or a render.
 *
 * Returns [] when the whole op list is valid; otherwise one error per bad op.
 */
export function validateOps(ops: Op[], digest: Digest, edl: Edl): ValidationError[] {
  const errors: ValidationError[] = [];

  const candidateIds = new Set(digest.entries.map((e) => e.id));
  const entryIds = new Set(edl.entries.map((e) => e.id));
  // An op may target either a candidate id (c001) or an EDL entry id (e_c001).
  const knownId = (id: string) => candidateIds.has(id) || entryIds.has(id);

  for (const op of ops) {
    switch (op.op) {
      case 'classify': {
        const unknown = op.keyIds.filter((id) => !candidateIds.has(id));
        if (unknown.length) errors.push({ op, reason: `unknown candidate id(s): ${unknown.join(', ')}` });
        break;
      }
      case 'retime': {
        if (!op.ids.length) errors.push({ op, reason: 'retime needs at least one id' });
        const unknown = op.ids.filter((id) => !knownId(id));
        if (unknown.length) errors.push({ op, reason: `unknown id(s): ${unknown.join(', ')}` });
        if (!(op.speed >= MIN_SPEED && op.speed <= MAX_SPEED)) {
          errors.push({ op, reason: `speed ${op.speed} out of range [${MIN_SPEED}, ${MAX_SPEED}]` });
        }
        break;
      }
      case 'overlay': {
        const unknown = op.ids.filter((id) => !knownId(id));
        if (unknown.length) errors.push({ op, reason: `unknown id(s): ${unknown.join(', ')}` });
        if (!op.text.trim()) errors.push({ op, reason: 'overlay text is empty' });
        break;
      }
      case 'insert': {
        if (!knownId(op.beforeId)) errors.push({ op, reason: `unknown insert anchor: ${op.beforeId}` });
        if (!op.card.text.trim()) errors.push({ op, reason: 'card text is empty' });
        if (!(op.card.durationSec > 0 && op.card.durationSec <= 30)) {
          errors.push({ op, reason: `card duration ${op.card.durationSec}s out of range (0,30]` });
        }
        break;
      }
      case 'cut': {
        if (!op.ids.length) errors.push({ op, reason: 'cut needs at least one id' });
        const unknown = op.ids.filter((id) => !knownId(id));
        if (unknown.length) errors.push({ op, reason: `unknown id(s): ${unknown.join(', ')}` });
        break;
      }
      case 'audio': {
        const unknown = op.ids.filter((id) => !knownId(id));
        if (unknown.length) errors.push({ op, reason: `unknown id(s): ${unknown.join(', ')}` });
        break;
      }
      case 'reframe':
      case 'export':
        break;
      default: {
        // Exhaustiveness guard: an unrecognized op shape is rejected outright.
        errors.push({ op: op as Op, reason: 'unrecognized op' });
      }
    }
  }
  return errors;
}

/** Type guard used by apply: export is not a mutation. */
export function isMutating(op: Op): op is MutatingOp {
  return op.op !== 'export';
}
