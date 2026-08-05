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
import type { Analysis, Atom, Candidate, Digest, Edl, Overlay, ValidationError, VideoSummary } from './types.js';

export interface SessionConfig {
  segment?: SegmentConfig;
  postprocess?: PostProcessConfig;
}

export type PromptOutcome =
  | { ok: true; edl: Edl; interpretation: string }
  | { ok: false; errors: ValidationError[]; interpretation: string };

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
