/**
 * Core data model for the local-first prompt-driven video editor.
 *
 * The design invariant: the agent edits a *document about the video* (the EDL).
 * Pixels are never touched until a single export render. Every type here is
 * plain data — serializable, cacheable, testable, and it never carries frames
 * or audio, only text and numbers derived from them.
 */

// ---------------------------------------------------------------------------
// Import artifacts (produced locally by the import pass; cached by file hash)
// ---------------------------------------------------------------------------

/** One transcript token with word-level timing (from whisper.cpp). */
export interface Word {
  text: string;
  /** seconds from start of source */
  start: number;
  /** seconds from start of source */
  end: number;
}

/** A detected object on a sparsely-sampled keyframe. */
export interface Detection {
  /** seconds from start of source */
  at: number;
  /** e.g. "drill", "person", "circuit board" */
  labels: string[];
}

/** A local-VLM caption on a surviving high-interest keyframe. */
export interface Caption {
  at: number;
  text: string;
}

/**
 * Everything the import pass extracts from one source file. This is the only
 * thing later stages read; the raw media is opened again only at export.
 */
export interface Analysis {
  /** content hash of the source file — the cache key for the whole pipeline */
  fileHash: string;
  durationSec: number;
  /** whether the source has an audio stream (screen recordings often don't) */
  hasAudio: boolean;
  /** word-level transcript (empty when there is no audio) */
  words: Word[];
  /** per-second activity score in [0,1] from the container scan (no decode) */
  activityPerSec: number[];
  /** scene-cut candidate times (seconds), from packet/I-frame analysis */
  sceneCuts: number[];
  detections: Detection[];
  captions: Caption[];
}

// ---------------------------------------------------------------------------
// Segmentation
// ---------------------------------------------------------------------------

/**
 * An atom is the smallest unit a cut may land on (~5–15 s). Boundaries come
 * from silences, sentence ends, and scene cuts. No cut may ever fall off an
 * atom boundary — this is what guarantees "no cut mid-word".
 */
export interface Atom {
  id: string;
  start: number;
  end: number;
  /** why this boundary exists — useful for debugging segmentation */
  reason: 'silence' | 'sentence' | 'scene' | 'start' | 'end' | 'interval';
}

/**
 * A candidate (~20–90 s) is the unit the agent reasons about: adjacent atoms
 * merged while the speaker continues, no scene change, flat activity. The
 * digest has one entry per candidate. IDs are stable and content-derived.
 */
export interface Candidate {
  id: string;
  /** user-visible ordinal (1-based) — the number shown on the timeline */
  index: number;
  start: number;
  end: number;
  atomIds: string[];
  /** first ~25 words of speech in this candidate */
  speechPreview: string;
  /** mean activity in [0,1] over the span */
  activity: number;
  /** union of detected object labels in the span */
  objects: string[];
  /** representative caption for the span, if any keyframe survived */
  caption?: string;
}

/** One line of the digest — the ONLY artifact permitted to cross the network. */
export interface DigestEntry {
  id: string;
  index: number;
  start: number;
  end: number;
  speech: string;
  activity: number;
  objects: string[];
  caption?: string;
}

export interface Digest {
  fileHash: string;
  durationSec: number;
  entries: DigestEntry[];
}

// ---------------------------------------------------------------------------
// EDL — the edit decision list (the "document about the video")
// ---------------------------------------------------------------------------

export type SegmentClass = 'key' | 'skip';

/** A slice of source footage placed on the output timeline. */
export interface SegmentEntry {
  kind: 'segment';
  id: string;
  /** the candidate this slice came from (for pinning / reference by number) */
  candidateId: string;
  index: number;
  /** source in/out points (seconds) */
  sourceStart: number;
  sourceEnd: number;
  /** playback speed multiplier; 1 = realtime, 10 = 10× */
  speed: number;
  /** classification that drove the speed mapping */
  class: SegmentClass;
  label?: string;
  /** audio treatment for this slice, if the user asked for one */
  audio?: 'mute' | 'music' | 'duck';
  /** true once the user hand-adjusts this entry; prompts must not touch it */
  pinned: boolean;
}

/** An inserted title/chapter card (not sourced from footage). */
export interface CardEntry {
  kind: 'card';
  id: string;
  /** seconds of screen time */
  durationSec: number;
  text: string;
  style?: string;
  pinned: boolean;
}

export type EdlEntry = SegmentEntry | CardEntry;

// ---------------------------------------------------------------------------
// Overlay layer — text / emoji / boxes that float ABOVE the composited video.
// Overlays are their OWN objects (not a property of a segment): each has its own
// timing, position and style, so the user can move it, restyle it, and set how
// long it runs independently of the cut. This is what makes labels a real layer.
// ---------------------------------------------------------------------------

export type OverlayKind = 'text' | 'emoji';

/**
 * Timing anchor. `segment` mode pins the overlay to a segment's output extent
 * (auto-labels ride with their clip through retimes); `output` mode pins it to
 * an absolute window on the edited timeline (freeform overlays the user drags).
 */
export type OverlayAnchor =
  | { mode: 'segment'; segmentId: string }
  | { mode: 'output'; start: number; duration: number };

export interface Overlay {
  id: string;
  kind: OverlayKind;
  /** the text, or the emoji character(s) */
  content: string;
  /** centre position as a fraction of the frame, 0..1 (x from left, y from top) */
  x: number;
  y: number;
  /** height as a fraction of frame height (font/emoji size) */
  size: number;
  color?: string;
  /** draw a translucent box behind text for legibility */
  box?: boolean;
  anchor: OverlayAnchor;
  /** user-created / hand-edited overlays are pinned; prompts won't touch them */
  pinned: boolean;
}

/** Output aspect ratio target. */
export type Aspect = 'source' | '16:9' | '9:16' | '1:1';

export interface Edl {
  fileHash: string;
  entries: EdlEntry[];
  /** the overlay track — layered over the composited segments at render */
  overlays: Overlay[];
  aspect: Aspect;
}

// ---------------------------------------------------------------------------
// Op DSL — the only mutations that exist
// ---------------------------------------------------------------------------

export type OverlayStyle = 'label' | 'chapter' | 'badge';

/**
 * The complete op vocabulary. Every user sentence compiles to these. The agent
 * *proposes* ops; nothing executes mid-loop. A validated op list becomes one
 * atomic patch applied to the EDL.
 */
export type Op =
  | { op: 'classify'; definition: string; keyIds: string[] }
  | { op: 'retime'; ids: string[]; speed: number }
  | { op: 'overlay'; ids: string[]; text: string; style: OverlayStyle }
  | { op: 'insert'; card: { text: string; durationSec: number; style?: string }; beforeId: string }
  | { op: 'cut'; ids: string[] }
  | { op: 'audio'; action: 'mute' | 'music' | 'duck'; ids: string[] }
  | { op: 'reframe'; aspect: Aspect }
  // overlay-layer mutations (used by manual GUI edits and, later, the agent)
  | { op: 'add_overlay'; overlay: Omit<Overlay, 'id' | 'pinned'> & { id?: string; pinned?: boolean } }
  | { op: 'update_overlay'; id: string; patch: Partial<Omit<Overlay, 'id'>> }
  | { op: 'remove_overlay'; id: string }
  | { op: 'export'; kind: 'video' | 'chapters' | 'description' };

export type MutatingOp = Exclude<Op, { op: 'export' }>;

// ---------------------------------------------------------------------------
// Patches, history, and results
// ---------------------------------------------------------------------------

export interface Patch {
  /** the instruction that produced this patch (for the undo label) */
  instruction: string;
  ops: MutatingOp[];
  /** parsed interpretation shown back to the user above the EDL */
  interpretation: string;
}

export interface ValidationError {
  op: Op;
  reason: string;
}

export type ApplyResult =
  | { ok: true; edl: Edl }
  | { ok: false; errors: ValidationError[] };
