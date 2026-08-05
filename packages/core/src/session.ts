import { applyOps } from './apply.js';
import { buildDigest } from './digest.js';
import { initialEdl } from './edl.js';
import { History } from './history.js';
import { HeuristicBackend } from './intelligence/heuristic.js';
import type { Backend, HistoryEntry } from './intelligence/index.js';
import { normalize, type PostProcessConfig } from './postprocess.js';
import { segment, type SegmentConfig } from './segment.js';
import { ReadTools } from './tools/read.js';
import { isMutating, validateOps } from './validate.js';
import type { Analysis, Atom, Candidate, Digest, Edl, Overlay, ValidationError, VideoHighlights, VideoSummary } from './types.js';

export interface SessionConfig {
  segment?: SegmentConfig;
  postprocess?: PostProcessConfig;
}

export type PromptOutcome =
  | { ok: true; edl: Edl; interpretation: string }
  | { ok: false; errors: ValidationError[]; interpretation: string };

/** Result of routing a chat message — either an applied edit or a text answer. */
export type ChatOutcome =
  | { kind: 'edit'; ok: true; interpretation: string; edl: Edl; usedFallback: boolean }
  | { kind: 'answer'; ok: true; text: string };

const ACTION_VERB =
  /^(speed|slow|cut|remove|delete|drop|add|insert|make|set|label|caption|overlay|mute|keep|retime|split|merge|reorder|change|put|apply|classify|mark|trim|shorten|lengthen|extend|undo|redo)\b/;
const QUESTION_WORD =
  /^(what|what's|who|whose|why|how|when|where|which|is|are|was|were|does|do|did|tell me|explain|describe|summarize|summarise|give me a summary|list)\b/;

/**
 * Is this message a question about the video rather than an edit instruction?
 * "can you speed up the intro?" must edit; "what are the key highlights?" must
 * answer — so strip polite/aux prefixes, then let action verbs beat question
 * words, and question words / trailing "?" mark the rest as questions.
 */
export function isQuestion(message: string): boolean {
  const t = message
    .trim()
    .toLowerCase()
    .replace(/^(can|could|would|will) you (please )?/, '')
    .replace(/^please /, '');
  if (ACTION_VERB.test(t)) return false;
  if (QUESTION_WORD.test(t)) return true;
  return t.endsWith('?');
}

/**
 * A live editing session over one imported file. Holds the immutable analysis
 * artifacts, the derived digest, the atom set (for snapping), and the undo
 * history. `prompt()` runs one turn of the interactive loop:
 *
 *   instruction → backend.plan → validate → apply → normalize → commit
 *
 * A rejected patch leaves the EDL and history completely untouched — the core
 * safety invariant.
 */
export class Session {
  readonly analysis: Analysis;
  readonly atoms: Atom[];
  readonly candidates: Candidate[];
  readonly digest: Digest;
  private readonly history: History;
  private readonly tools: ReadTools;
  private readonly log: HistoryEntry[] = [];

  constructor(analysis: Analysis, private cfg: SessionConfig = {}) {
    this.analysis = analysis;
    const seg = segment(analysis, cfg.segment);
    this.atoms = seg.atoms;
    this.candidates = seg.candidates;
    this.digest = buildDigest(analysis.fileHash, analysis.durationSec, this.candidates);
    const edl0 = normalize(initialEdl(analysis.fileHash, this.candidates), this.atoms, cfg.postprocess);
    this.history = new History(edl0, 'import');
    this.tools = new ReadTools(analysis, this.candidates, this.digest, () => this.history.edl);
  }

  get edl(): Edl {
    return this.history.edl;
  }

  /** Ask a backend to propose a patch for an instruction (no apply). */
  async proposePatch(instruction: string, backend: Backend) {
    return backend.plan({
      digest: this.digest,
      edl: this.history.edl,
      history: this.log.slice(-5),
      instruction,
      tools: this.tools,
    });
  }

  /**
   * Route a chat message: apply it as an edit if it yields valid ops, otherwise
   * answer it as a question. `fallback` (the heuristic) retries edits whose ops
   * the primary model got wrong. This is what lets the right-hand chat both edit
   * and answer questions instead of silently no-opping.
   */
  async chat(backend: Backend, message: string, fallback?: Backend): Promise<ChatOutcome> {
    // Questions route straight to Q&A — never to the edit path. This is what
    // stops "what are the key highlights?" from being applied as a classify op.
    if (isQuestion(message)) {
      const text = await this.answer(backend, message);
      return { kind: 'answer', ok: true, text };
    }

    let patch = null as Awaited<ReturnType<Session['proposePatch']>> | null;
    try {
      patch = await this.proposePatch(message, backend);
    } catch {
      patch = null;
    }

    const tryApply = (p: typeof patch, usedFallback: boolean): ChatOutcome | null => {
      if (!p || !p.ops.length) return null;
      const errs = validateOps(p.ops, this.digest, this.history.edl);
      if (errs.length) return null;
      const mutating = p.ops.filter(isMutating);
      const applied = applyOps(this.history.edl, mutating, { explicitIds: this.detectExplicitIds(message) });
      this.history.commit(normalize(applied, this.atoms, this.cfg.postprocess), message);
      this.log.push({ instruction: message, interpretation: p.interpretation });
      return { kind: 'edit', ok: true, interpretation: p.interpretation, edl: this.history.edl, usedFallback };
    };

    // 1) primary as an edit
    const primary = tryApply(patch, false);
    if (primary) return primary;
    // 2) if the primary had ops but they were invalid, retry the edit with fallback
    if (fallback && patch && patch.ops.length) {
      const fp = await this.proposePatch(message, fallback).catch(() => null);
      const viaFallback = tryApply(fp, true);
      if (viaFallback) return viaFallback;
    }
    // 3) no valid edit → answer it as a question
    const text = await this.answer(backend, message);
    return { kind: 'answer', ok: true, text };
  }

  /** Run one instruction through the loop. Returns the new EDL or the errors. */
  async prompt(instruction: string, backend: Backend): Promise<PromptOutcome> {
    const patch = await backend.plan({
      digest: this.digest,
      edl: this.history.edl,
      history: this.log.slice(-5),
      instruction,
      tools: this.tools,
    });

    const errors = validateOps(patch.ops, this.digest, this.history.edl);
    if (errors.length) {
      // Hard contract: an unknown id or malformed op → visible error, no change.
      return { ok: false, errors, interpretation: patch.interpretation };
    }

    const mutating = patch.ops.filter(isMutating);
    // A recognized-but-empty patch changes nothing and must not create an undo
    // step (otherwise Ctrl-Z would swallow a no-op before the real last edit).
    if (mutating.length === 0) {
      return { ok: true, edl: this.history.edl, interpretation: patch.interpretation };
    }

    const explicitIds = this.detectExplicitIds(instruction);
    const applied = applyOps(this.history.edl, mutating, { explicitIds });
    const normalized = normalize(applied, this.atoms, this.cfg.postprocess);

    this.history.commit(normalized, instruction);
    this.log.push({ instruction, interpretation: patch.interpretation });
    return { ok: true, edl: normalized, interpretation: patch.interpretation };
  }

  /** Mark an entry as hand-adjusted so later prompts leave it alone. */
  pin(entryId: string): void {
    const edl = this.history.edl;
    const entries = edl.entries.map((e) => (e.id === entryId ? { ...e, pinned: true } : e));
    this.history.commit({ ...edl, entries }, `pin ${entryId}`);
  }

  /** Manually set a segment's speed (a manual edit; also pins it). */
  setSpeed(entryId: string, speed: number): void {
    const edl = this.history.edl;
    const entries = edl.entries.map((e) =>
      e.id === entryId && e.kind === 'segment' ? { ...e, speed, pinned: true } : e,
    );
    this.history.commit({ ...edl, entries }, `set ${entryId} → ${speed}×`);
  }

  /** Add an overlay to the layer (a manual edit; the overlay is pinned). */
  addOverlay(overlay: Omit<Overlay, 'id' | 'pinned'> & { id?: string }): Overlay {
    const applied = applyOps(this.history.edl, [{ op: 'add_overlay', overlay: { ...overlay, pinned: true } }]);
    this.history.commit(applied, `add ${overlay.kind} overlay`);
    return applied.overlays[applied.overlays.length - 1]!;
  }

  /** Update an overlay (move, resize, restyle, retime). Manual edit. */
  updateOverlay(id: string, patch: Partial<Omit<Overlay, 'id'>>, label = 'edit overlay'): void {
    const applied = applyOps(this.history.edl, [{ op: 'update_overlay', id, patch }]);
    this.history.commit(applied, label);
  }

  removeOverlay(id: string): void {
    const applied = applyOps(this.history.edl, [{ op: 'remove_overlay', id }]);
    this.history.commit(applied, `remove overlay`);
  }

  private summaryCache: VideoSummary | null = null;

  /**
   * Produce (and cache) a human summary of the video: a 1–2 sentence overview
   * and a one-line label per moment. Uses the given backend's `summarize` when
   * available; falls back to the deterministic heuristic on absence or error, so
   * a summary is always returned.
   */
  async summarize(backend: Backend, force = false): Promise<VideoSummary> {
    if (this.summaryCache && !force) return this.summaryCache;
    let result: VideoSummary | null = null;
    if (backend.summarize) {
      try {
        result = await backend.summarize(this.digest);
      } catch {
        result = null;
      }
    }
    if (!result || !result.moments.length) {
      result = await new HeuristicBackend().summarize(this.digest);
    }
    // Ensure every candidate has a label (fill gaps from the heuristic).
    const have = new Set(result.moments.map((m) => m.id));
    if (this.digest.entries.some((e) => !have.has(e.id))) {
      const fallback = await new HeuristicBackend().summarize(this.digest);
      const fmap = new Map(fallback.moments.map((m) => [m.id, m.label]));
      result.moments = this.digest.entries.map(
        (e) => result!.moments.find((m) => m.id === e.id) ?? { id: e.id, label: fmap.get(e.id) ?? '' },
      );
    }
    this.summaryCache = result;
    return result;
  }

  private highlightsCache: VideoHighlights | null = null;

  /**
   * Ranked key moments with reasons ("which moments matter and why"). Uses the
   * backend's `highlights` (LLM-judged); falls back to the activity heuristic.
   */
  async getHighlights(backend: Backend, force = false): Promise<VideoHighlights> {
    if (this.highlightsCache && !force) return this.highlightsCache;
    let result: VideoHighlights | null = null;
    if (backend.highlights) {
      try {
        result = await backend.highlights(this.digest);
        // Drop any hallucinated ids the validator would reject.
        const known = new Set(this.digest.entries.map((e) => e.id));
        result.highlights = result.highlights.filter((h) => known.has(h.id));
      } catch {
        result = null;
      }
    }
    if (!result || !result.highlights.length) {
      result = await new HeuristicBackend().highlights(this.digest);
    }
    this.highlightsCache = result;
    return result;
  }

  /**
   * Answer a question about the video (chat, not an edit). Uses the backend's
   * `answer` with the digest + cached summary; falls back to the heuristic.
   */
  async answer(backend: Backend, question: string): Promise<string> {
    const summary = this.summaryCache?.summary;
    const ctx = { digest: this.digest, summary, question, history: this.log.slice(-5) };
    if (backend.answer) {
      try {
        const a = await backend.answer(ctx);
        if (a.trim()) return a.trim();
      } catch {
        /* fall through */
      }
    }
    return new HeuristicBackend().answer(ctx);
  }

  undo(): string | null {
    return this.history.undo();
  }
  redo(): string | null {
    return this.history.redo();
  }
  timeline(): string[] {
    return this.history.timeline();
  }

  /**
   * Ids the user explicitly named ("segment 12", "#3", "c007"), which are
   * allowed to override pinning. Broad rules ("the fast parts") name nothing.
   */
  private detectExplicitIds(instruction: string): Set<string> {
    const ids = new Set<string>();
    for (const m of instruction.matchAll(/\b(?:segment|seg|#)\s*#?(\d+)\b/gi)) {
      const idx = Number(m[1]);
      const cand = this.candidates.find((c) => c.index === idx);
      if (cand) ids.add(cand.id);
    }
    for (const m of instruction.matchAll(/\b(c\d{3})\b/g)) ids.add(m[1]!);
    return ids;
  }
}
