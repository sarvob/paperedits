import { cloneEdl } from './edl.js';
import type { CardEntry, Edl, EdlEntry, MutatingOp, Overlay, SegmentEntry } from './types.js';

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

let overlaySeq = 0;
function nextOverlayId(): string {
  overlaySeq += 1;
  return `ov_${overlaySeq}`;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;

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
        // Create a real overlay-layer object anchored to each targeted segment
        // (auto-labels ride with their clip). Keep `label` too, for chapter
        // export. Replace any existing non-pinned auto-label on that segment so
        // re-running "label the fast parts" doesn't stack duplicates.
        for (const e of next.entries) {
          if (!isSegment(e) || !targets(op.ids, e) || !mayTouch(e, explicit)) continue;
          e.label = op.text;
          next.overlays = next.overlays.filter(
            (o) => !(o.anchor.mode === 'segment' && o.anchor.segmentId === e.id && !o.pinned),
          );
          next.overlays.push({
            id: nextOverlayId(),
            kind: EMOJI_RE.test(op.text) && [...op.text].length <= 3 ? 'emoji' : 'text',
            content: op.text,
            x: 0.5,
            y: 0.86,
            size: 0.07,
            color: '#ffffff',
            box: op.style !== 'badge',
            anchor: { mode: 'segment', segmentId: e.id },
            pinned: false,
          });
        }
        break;
      }
      case 'add_overlay': {
        const o: Overlay = {
          id: op.overlay.id ?? nextOverlayId(),
          kind: op.overlay.kind,
          content: op.overlay.content,
          x: op.overlay.x,
          y: op.overlay.y,
          size: op.overlay.size,
          ...(op.overlay.color ? { color: op.overlay.color } : {}),
          ...(op.overlay.box != null ? { box: op.overlay.box } : {}),
          anchor: op.overlay.anchor,
          pinned: op.overlay.pinned ?? true,
        };
        next.overlays.push(o);
        break;
      }
      case 'update_overlay': {
        next.overlays = next.overlays.map((o) =>
          o.id === op.id ? { ...o, ...op.patch, id: o.id } : o,
        );
        break;
      }
      case 'remove_overlay': {
        next.overlays = next.overlays.filter((o) => o.id !== op.id);
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
        const removed = new Set<string>();
        next.entries = next.entries.filter((e) => {
          if (!isSegment(e)) return true;
          if (!targets(op.ids, e)) return true;
          // A broad cut skips pinned entries; an explicit cut removes them.
          if (mayTouch(e, explicit)) {
            removed.add(e.id);
            return false;
          }
          return true;
        });
        // Drop overlays that were anchored to a removed segment.
        next.overlays = next.overlays.filter(
          (o) => !(o.anchor.mode === 'segment' && removed.has(o.anchor.segmentId)),
        );
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
