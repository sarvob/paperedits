import { cloneEdl } from './edl.js';
import type { CardEntry, Edl, EdlEntry, MutatingOp, SegmentEntry } from './types.js';

export interface ApplyOptions {
  /**
   * Candidate/entry ids the user *explicitly named* in this instruction
   * (e.g. "split segment 12"). Only these may modify a pinned entry; broad
   * rules never touch pinned segments. Empty = every op is treated as a rule.
   */
  explicitIds?: Set<string>;
}

function isSegment(e: EdlEntry): e is SegmentEntry {
  return e.kind === 'segment';
}

/**
 * True if this op is allowed to mutate the given entry: either the entry is not
 * pinned, or the user explicitly named it in the instruction.
 */
function mayTouch(entry: EdlEntry, explicit: Set<string>): boolean {
  if (!entry.pinned) return true;
  if (explicit.has(entry.id)) return true;
  return entry.kind === 'segment' && explicit.has(entry.candidateId);
}

/** An op targets an entry if it lists the entry id OR the entry's candidate id. */
function targets(ids: string[], entry: SegmentEntry): boolean {
  return ids.includes(entry.id) || ids.includes(entry.candidateId);
}

let cardSeq = 0;
function nextCardId(): string {
  cardSeq += 1;
  return `card_${cardSeq}`;
}

/**
 * Apply a validated op list to the EDL, returning a new EDL. Assumes ops have
 * already passed validateOps — this function does no id-existence checking, it
 * only performs the mutation while respecting pinning.
 */
export function applyOps(edl: Edl, ops: MutatingOp[], opts: ApplyOptions = {}): Edl {
  const explicit = opts.explicitIds ?? new Set<string>();
  let next = cloneEdl(edl);

  for (const op of ops) {
    switch (op.op) {
      case 'classify': {
        const keySet = new Set(op.keyIds);
        next.entries = next.entries.map((e) => {
          if (!isSegment(e) || !mayTouch(e, explicit)) return e;
          return { ...e, class: keySet.has(e.candidateId) ? 'key' : 'skip' };
        });
        break;
      }
      case 'retime': {
        next.entries = next.entries.map((e) => {
          if (!isSegment(e) || !targets(op.ids, e) || !mayTouch(e, explicit)) return e;
          return { ...e, speed: op.speed };
        });
        break;
      }
      case 'overlay': {
        next.entries = next.entries.map((e) => {
          if (!isSegment(e) || !targets(op.ids, e) || !mayTouch(e, explicit)) return e;
          return { ...e, label: op.text };
        });
        break;
      }
      case 'audio': {
        next.entries = next.entries.map((e) => {
          if (!isSegment(e) || !targets(op.ids, e) || !mayTouch(e, explicit)) return e;
          return { ...e, audio: op.action };
        });
        break;
      }
      case 'cut': {
        next.entries = next.entries.filter((e) => {
          if (!isSegment(e)) return true;
          if (!targets(op.ids, e)) return true;
          // A broad cut skips pinned entries; an explicit cut removes them.
          return !mayTouch(e, explicit);
        });
        break;
      }
      case 'insert': {
        const card: CardEntry = {
          kind: 'card',
          id: nextCardId(),
          durationSec: op.card.durationSec,
          text: op.card.text,
          ...(op.card.style ? { style: op.card.style } : {}),
          pinned: false,
        };
        const idx = next.entries.findIndex(
          (e) => e.id === op.beforeId || (isSegment(e) && e.candidateId === op.beforeId),
        );
        if (idx >= 0) next.entries.splice(idx, 0, card);
        else next.entries.push(card);
        break;
      }
      case 'reframe': {
        next = { ...next, aspect: op.aspect };
        break;
      }
    }
  }

  // Keep user-visible ordinals stable and dense after inserts/cuts.
  let n = 0;
  next.entries = next.entries.map((e) => (isSegment(e) ? { ...e, index: ++n } : e));
  return next;
}
