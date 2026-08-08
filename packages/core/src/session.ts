import { applyOps } from './apply.js';
import { buildDigest } from './digest.js';
import { initialEdl, outputDuration } from './edl.js';
import { History } from './history.js';
import { canonicalizeId, canonicalizeOps } from './ids.js';
import { shouldAct, type Intent } from './intent.js';
import { assembleNarrative, buildTopics, type Topic, type TopicVerdict } from './narrative.js';
import { HeuristicBackend } from './intelligence/heuristic.js';
import type { Backend, HistoryEntry } from './intelligence/index.js';
import { normalize, type PostProcessConfig } from './postprocess.js';
import { segment, type SegmentConfig } from './segment.js';
import { ReadTools } from './tools/read.js';
import { isMutating, validateOps } from './validate.js';
import type { Analysis, Atom, Candidate, Digest, Edl, MutatingOp, Overlay, ValidationError, VideoHighlights, VideoSummary } from './types.js';

export interface SessionConfig {
  segment?: SegmentConfig;
  postprocess?: PostProcessConfig;
}

export type PromptOutcome =
  | { ok: true; edl: Edl; interpretation: string }
  | { ok: false; errors: ValidationError[]; interpretation: string };

/** One row of the agent's visible plan: what it decided per segment and why. */
export interface AgentPlanItem {
  id: string;
  speed: number;
  reason: string;
}

/** Result of routing a chat message — either an applied edit or a text answer. */
export type ChatOutcome =
  | { kind: 'edit'; ok: true; interpretation: string; edl: Edl; usedFallback: boolean; plan?: AgentPlanItem[] }
  | { kind: 'answer'; ok: true; text: string };

/**
 * Extract a duration from text.
 *
 * NOT used for routing — the model reports the target directly as part of the
 * intent. Kept only as a deterministic helper for the no-model heuristic
 * backend. Do not reintroduce it as an intent test: deciding whether the user
 * asked for a length is semantics, and keyword rules got that wrong.
 */
export function parseTargetDuration(message: string): { targetSec: number; fastSpeed: number } | null {
  const t = message.toLowerCase();
  const intent = /(under|less|below|within|max|total|down ?to|shorten|reduce|length|final|end up|make (it|this))/.test(t);
  if (!intent) return null;
  const fastMatches = [...t.matchAll(/(\d+(?:\.\d+)?)\s*x\b/g)].map((m) => Number(m[1])).filter((v) => v > 1);
  const fastSpeed = fastMatches.length ? Math.max(...fastMatches) : 10;
  const min = t.match(/(\d+(?:\.\d+)?)\s*min/);
  if (min) return { targetSec: Number(min[1]) * 60, fastSpeed };
  const sec = t.match(/(\d+)\s*sec/);
  if (sec) return { targetSec: Number(sec[1]), fastSpeed };
  return null;
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
  // digest is rebuilt in place when the background visual pass lands (see
  // applyVisual) — segmentation and the EDL never change, only digest richness.
  readonly atoms: Atom[];
  readonly candidates: Candidate[];
  digest: Digest;
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
    // The goal rides along as context, not as part of the command itself.
    const withGoal = this.goal ? `${instruction}\n(The user's overall goal for this video: ${this.goal})` : instruction;
    const patch = await backend.plan({
      digest: this.digest,
      edl: this.history.edl,
      history: this.log.slice(-5),
      instruction: withGoal,
      tools: this.tools,
    });
    // Repair id formatting before validation so a well-judged edit isn't
    // rejected over a missing zero. Truly unknown ids survive unchanged and
    // are still rejected downstream.
    const known = new Set(this.digest.entries.map((e) => e.id));
    return { ...patch, ops: canonicalizeOps(patch.ops, known) };
  }

  /**
   * Route a chat message: apply it as an edit if it yields valid ops, otherwise
   * answer it as a question. `fallback` (the heuristic) retries edits whose ops
   * the primary model got wrong. This is what lets the right-hand chat both edit
   * and answer questions instead of silently no-opping.
   */
  /** Rolling chat transcript so follow-ups ("why?", "that one") have context. */
  chatLog: { role: 'user' | 'assistant'; text: string }[] = [];
  /** One-line record of the last edit the agent performed — the referent of "why". */
  lastAction: string | null = null;
  /** The user's stated job for this video ("podcast → highlight reel", …). */
  goal: string | null = null;
  setGoal(g: string | null): void {
    this.goal = g?.trim() || null;
  }
  /** A proposal awaiting the user's choice (e.g. an infeasible duration target). */
  private pending: { targetSec: number; fastSpeed: number; totalSec: number; minSec: number } | null = null;

  async chat(backend: Backend, message: string, fallback?: Backend, onToken?: (t: string) => void): Promise<ChatOutcome> {
    this.chatLog.push({ role: 'user', text: message });
    const out = await this.routeChat(backend, message, fallback, onToken);
    this.chatLog.push({ role: 'assistant', text: out.kind === 'answer' ? out.text : out.interpretation });
    if (this.chatLog.length > 16) this.chatLog.splice(0, this.chatLog.length - 16);
    return out;
  }

  /**
   * Ask a model what the user meant.
   *
   * If neither the selected backend nor the fallback can classify — no model
   * loaded at all — we do NOT drop back to keyword rules. That is what caused
   * questions to silently edit the timeline. With no semantics available the
   * honest answer is to ask the user, which is also a legible prompt to start
   * Ollama or pick a backend.
   */
  private async readIntent(backend: Backend, message: string, fallback?: Backend): Promise<Intent> {
    const pendingProposal = this.pending
      ? `The agent offered three options for hitting a ${Math.round(this.pending.targetSec)}s target: ` +
        `(1) compress harder, (2) cut the least important segments, (3) accept a longer result.`
      : undefined;
    const opts = { conversation: this.chatLog.slice(-4), pendingProposal };
    for (const b of [backend, fallback]) {
      if (!b?.classifyIntent) continue;
      try {
        return await b.classifyIntent(message, opts);
      } catch {
        /* try the next backend */
      }
    }
    return {
      kind: 'unclear',
      question:
        'I need a language model to understand that reliably, and none is responding. ' +
        'Start Ollama (or pick a backend in the Intelligence panel) — or tell me plainly, ' +
        'e.g. "answer: what is this about" or "edit: speed up the quiet parts".',
    };
  }

  private async routeChat(backend: Backend, message: string, fallback?: Backend, onToken?: (t: string) => void): Promise<ChatOutcome> {
    const fmtD = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

    // What did they mean? A model decides — never keyword rules. Routing by
    // pattern failed on every phrasing nobody thought to enumerate, and a
    // misroute silently mutated the EDL. If no backend can classify, we ASK
    // rather than guess.
    const intent = await this.readIntent(backend, message, fallback);

    // Not confident, or confident but destructive and ambiguous → put it back
    // to the user. Asking costs a second; a wrong guess costs their edit.
    if (!shouldAct(intent)) {
      const q =
        intent.kind === 'unclear'
          ? intent.question
          : 'I want to make sure before I change anything — what would you like me to do?';
      return { kind: 'answer', ok: true, text: q };
    }

    if (intent.kind === 'command') {
      if (intent.command === 'undo') {
        const l = this.undo();
        this.agentPlan = null;
        return { kind: 'edit', ok: true, interpretation: l ? `Undone: "${l}".` : 'Nothing to undo.', edl: this.edl, usedFallback: false };
      }
      const l = this.redo();
      return { kind: 'edit', ok: true, interpretation: l ? `Redone: "${l}".` : 'Nothing to redo.', edl: this.edl, usedFallback: false };
    }

    // --- pending proposal: the user is answering a question we asked -------
    if (this.pending && intent.kind === 'confirm') {
      const p = this.pending;
      this.pending = null;
      const neededSpeed = Math.ceil(p.totalSec / p.targetSec);
      switch (intent.choice) {
        case 'cancel':
          return { kind: 'answer', ok: true, text: 'Okay, cancelled — nothing was changed.' };
        case 'first':
          return this.runTargetPlan(backend, p.targetSec, neededSpeed, 'compress');
        case 'second':
          return this.runTargetPlan(backend, p.targetSec, p.fastSpeed, 'cut');
        default:
          return this.runTargetPlan(backend, p.minSec + 1, p.fastSpeed, 'compress');
      }
    }
    // They said something else entirely — drop the proposal, carry on.
    if (this.pending) this.pending = null;

    if (intent.kind === 'question') {
      const text = await this.answer(backend, message, onToken);
      return { kind: 'answer', ok: true, text };
    }

    // --- duration targets → feasibility check, then plan or ask ------------
    if (intent.kind === 'duration') {
      const totalSec = this.candidates.reduce((a, c) => a + (c.end - c.start), 0);
      const minSec = totalSec / intent.fastSpeed;
      if (intent.targetSec < minSec) {
        this.pending = { targetSec: intent.targetSec, fastSpeed: intent.fastSpeed, totalSec, minSec };
        const needed = Math.ceil(totalSec / intent.targetSec);
        return {
          kind: 'answer',
          ok: true,
          text:
            `That target isn't reachable as asked: the source is ${fmtD(totalSec)}, so even with ` +
            `EVERYTHING at ${intent.fastSpeed}× the result is ${fmtD(minSec)} — above your ${fmtD(intent.targetSec)} target.\n\n` +
            `Options:\n` +
            `1. Compress harder — about ${needed}× would fit (keeps everything, just faster)\n` +
            `2. Cut the least important segments entirely and keep the best at 1× (undoable)\n` +
            `3. Accept ${fmtD(minSec)} — apply everything at ${intent.fastSpeed}×\n\n` +
            `Reply 1, 2, or 3 (or e.g. "use ${needed}x"). I won't change anything until you choose.`,
        };
      }
      return this.runTargetPlan(backend, intent.targetSec, intent.fastSpeed, intent.removal ? 'cut' : 'compress');
    }

    // --- free-form edits via the op DSL ------------------------------------
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
      this.lastAction = p.interpretation;
      return { kind: 'edit', ok: true, interpretation: p.interpretation, edl: this.history.edl, usedFallback };
    };

    const primary = tryApply(patch, false);
    if (primary) return primary;
    if (fallback && patch && patch.ops.length) {
      const fp = await this.proposePatch(message, fallback).catch(() => null);
      const viaFallback = tryApply(fp, true);
      if (viaFallback) return viaFallback;
    }
    const text = await this.answer(backend, message);
    return { kind: 'answer', ok: true, text };
  }

  /** Apply a duration-target plan (mode: compress rest, or cut rest) + record why. */
  private async runTargetPlan(
    backend: Backend,
    targetSec: number,
    fastSpeed: number,
    mode: 'compress' | 'cut',
  ): Promise<ChatOutcome> {
    const fmtD = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const r = await this.planTargetDuration(backend, targetSec, fastSpeed, mode);
    const rest = this.candidates.length - r.kept;
    const interpretation =
      `Kept ${r.kept} key segment${r.kept === 1 ? '' : 's'} at 1× and ` +
      (mode === 'cut' ? `cut the other ${rest}` : `compressed the other ${rest} to ${fastSpeed}×`) +
      ` → new length ${fmtD(r.resultSec)} (target ${fmtD(targetSec)}). ` +
      `The plan track under the audio shows each decision and why. Say "undo" to revert` +
      (mode === 'compress' ? `, or "remove the rest instead" for a hard cut.` : `.`);
    this.lastAction = interpretation;
    return { kind: 'edit', ok: true, interpretation, edl: this.edl, usedFallback: false, plan: r.plan };
  }

  /** Run one instruction through the loop. Returns the new EDL or the errors. */
  async prompt(instruction: string, backend: Backend): Promise<PromptOutcome> {
    const patch = await this.proposePatch(instruction, backend);

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

  /**
   * Absorb the background visual pass into a LIVE session: candidates gain
   * captions/objects, the digest is rebuilt, and stale summary/highlights
   * caches are dropped — while the EDL, undo history, and chat all survive
   * untouched (captions never affect segmentation boundaries).
   */
  applyVisual(captions: { at: number; text: string }[], detections: { at: number; labels: string[] }[]): void {
    this.analysis.captions = captions;
    this.analysis.detections = detections;
    for (const c of this.candidates) {
      c.objects = [
        ...new Set(detections.filter((d) => d.at >= c.start && d.at < c.end).flatMap((d) => d.labels)),
      ];
      c.caption = captions.find((x) => x.at >= c.start && x.at < c.end)?.text;
    }
    this.digest = buildDigest(this.analysis.fileHash, this.analysis.durationSec, this.candidates);
    this.summaryCache = null;
    this.highlightsCache = null;
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
  /** The cached overall summary text, if one has been computed. */
  get currentSummary(): string | undefined {
    return this.summaryCache?.summary || undefined;
  }

  /**
   * Produce (and cache) a human summary of the video: a 1–2 sentence overview
   * and a one-line label per moment. Uses the given backend's `summarize` when
   * available; falls back to the deterministic heuristic on absence or error, so
   * a summary is always returned.
   */
  async summarize(backend: Backend, force = false): Promise<VideoSummary> {
    if (this.summaryCache && !force) return this.summaryCache;
    // Per-segment labels come from the heuristic ALWAYS: they are mechanical
    // (each segment's own speech), and asking the model for one per segment
    // made the response — and so the wait — scale with video length.
    const base = await new HeuristicBackend().summarize(this.digest);
    let result: VideoSummary | null = null;
    if (backend.summarize) {
      try {
        const llm = await backend.summarize(this.digest);
        if (llm.summary.trim()) result = { summary: llm.summary.trim(), moments: base.moments };
      } catch {
        result = null;
      }
    }
    if (!result) result = base;
    this.summaryCache = result;
    return result;
  }

  /** The agent's last visible plan (drawn as the plan track in the UI). */
  agentPlan: AgentPlanItem[] | null = null;

  /**
   * Hit a target output duration: the LLM's highlight ranking decides WHICH
   * segments matter; deterministic code decides HOW MANY can stay 1× so the
   * total fits. Applies the retimes as one undoable step and records a
   * per-segment plan with reasons.
   */
  async planTargetDuration(
    backend: Backend,
    targetSec: number,
    fastSpeed = 10,
    mode: 'compress' | 'cut' = 'compress',
  ): Promise<{ plan: AgentPlanItem[]; resultSec: number; kept: number }> {
    // Prefer the narrative planner: it judges every TOPIC against the user's
    // goal, so the cut is assembled from meaning rather than from which
    // segments happened to be loud. Falls back to highlight-ranked greedy.
    const narrative = await this.planNarrative(backend, targetSec, fastSpeed, mode).catch(() => null);
    if (narrative) return narrative;

    const hl = await this.getHighlights(backend).catch(() => ({ highlights: [] }) as VideoHighlights);
    const hlScore = new Map(hl.highlights.map((h) => [h.id, h.score]));
    const hlWhy = new Map(hl.highlights.map((h) => [h.id, h.why || h.title]));

    // Score every candidate: LLM highlight score wins; signal heuristic fills in.
    const scored = this.candidates
      .map((c) => ({
        c,
        s:
          hlScore.get(c.id) ??
          0.5 * c.activity + 0.3 * Math.min(1, c.speechPreview.split(/\s+/).filter(Boolean).length / 25),
      }))
      .sort((a, b) => b.s - a.s);
    const rank = new Map(scored.map((x, i) => [x.c.id, i + 1]));

    // Only segments still present in the EDL cost output time. An earlier edit
    // ("remove the technical demos") may already have cut some; counting those
    // as if they were still there makes the budget look full and over-compresses
    // what remains — measured: a 5:00 target landing at 3:33.
    const live = new Set(
      this.history.edl.entries.filter((e): e is Extract<typeof e, { kind: 'segment' }> => e.kind === 'segment').map((e) => e.candidateId),
    );
    const planned = this.candidates.filter((c) => live.has(c.id));

    // Greedy: keep the most important segments at 1× while the total fits.
    const keep = new Set<string>();
    const totalWith = (k: Set<string>) =>
      planned.reduce((a, c) => a + (k.has(c.id) ? c.end - c.start : (c.end - c.start) / fastSpeed), 0);
    // In 'cut' mode removed segments cost 0 output time; in 'compress' mode
    // they still cost len/fastSpeed — the fit accounts for the difference.
    const costWith = (k: Set<string>) =>
      mode === 'cut'
        ? planned.reduce((a, c) => a + (k.has(c.id) ? c.end - c.start : 0), 0)
        : totalWith(k);
    for (const { c } of scored) {
      if (!live.has(c.id)) continue; // already cut — leave it cut
      keep.add(c.id);
      if (costWith(keep) > targetSec) keep.delete(c.id);
    }

    const build = (k: Set<string>) => {
      const keepIds = [...k];
      const fastIds = planned.filter((c) => !k.has(c.id)).map((c) => c.id);
      const ops: MutatingOp[] = [{ op: 'classify', definition: `target ≤ ${Math.round(targetSec)}s`, keyIds: keepIds }];
      if (keepIds.length) ops.push({ op: 'retime', ids: keepIds, speed: 1 });
      if (fastIds.length) ops.push(mode === 'cut' ? { op: 'cut', ids: fastIds } : { op: 'retime', ids: fastIds, speed: fastSpeed });
      return normalize(applyOps(this.history.edl, ops, {}), this.atoms, this.cfg.postprocess);
    };

    // Closed loop: the greedy fit above is an ESTIMATE from candidate lengths,
    // but normalize() snaps to atoms and can flip short islands, which pushed a
    // 5:00 target to 5:02 in testing. "Under 5 minutes" has to mean under, so
    // measure the real EDL and demote the weakest keeps until it actually fits.
    //
    // The budget is also held slightly under the target because the RENDER is
    // longer than the EDL: every segment's duration snaps to a frame boundary,
    // which measured +0.33s across 18 segments (299.9s EDL → 300.2s file). The
    // promise has to hold for the exported file, not just the plan.
    const budget = targetSec - Math.max(1, targetSec * 0.005);
    let normalized = build(keep);
    const weakestFirst = scored.filter((x) => keep.has(x.c.id)).map((x) => x.c.id).reverse();
    for (const victim of weakestFirst) {
      if (outputDuration(normalized) <= budget) break;
      keep.delete(victim);
      normalized = build(keep);
    }

    const keepIds = [...keep];
    this.history.commit(normalized, mode === 'cut' ? `cut to fit ${Math.round(targetSec)}s` : `fit under ${Math.round(targetSec)}s`);

    this.agentPlan = planned
      .filter((c) => mode !== 'cut' || keep.has(c.id))
      .map((c) => ({
        id: c.id,
        speed: keep.has(c.id) ? 1 : fastSpeed,
        // Greedy packing means a higher-ranked but long segment can lose its
        // slot to a shorter one; say "didn't fit" rather than implying it was
        // judged less important than everything kept.
        reason: keep.has(c.id)
          ? hlWhy.get(c.id) ?? `Ranked #${rank.get(c.id)} by importance — kept at 1×`
          : `Rank #${rank.get(c.id)} — didn't fit the ${Math.round(targetSec)}s budget, compressed ${fastSpeed}×`,
      }));
    return { plan: this.agentPlan, resultSec: outputDuration(this.history.edl), kept: keepIds.length };
  }

  private topicCache: { topics: Topic[]; verdicts: Map<string, TopicVerdict> } | null = null;

  /** Topic map + the model's verdict on each, against the user's goal. */
  async understand(backend: Backend, force = false): Promise<{ topics: Topic[]; verdicts: Map<string, TopicVerdict> } | null> {
    if (this.topicCache && !force) return this.topicCache;
    if (!backend.planTopics) return null;
    const topics = buildTopics(this.analysis, this.candidates);
    if (topics.length < 2) return null;
    const raw = await backend.planTopics(
      topics.map((t) => ({ id: t.id, start: t.start, end: t.end, text: t.text })),
      this.goal ?? undefined,
      this.analysis.durationSec,
    );
    // Same repair as everywhere else: a formatting slip is not a hallucination.
    const known = new Set(topics.map((t) => t.id));
    const verdicts = new Map<string, TopicVerdict>();
    for (const v of raw) {
      const id = known.has(v.id) ? v.id : (topics.find((t) => t.id.endsWith(v.id.replace(/\D/g, '').padStart(2, '0')))?.id ?? '');
      if (id && !verdicts.has(id)) verdicts.set(id, { ...v, id });
    }
    if (!verdicts.size) return null;
    this.topicCache = { topics, verdicts };
    return this.topicCache;
  }

  /**
   * Assemble a cut from topic understanding: relevance to the goal, coverage
   * across topics, and a reserved opening and closing beat.
   */
  private async planNarrative(
    backend: Backend,
    targetSec: number,
    fastSpeed: number,
    mode: 'compress' | 'cut',
  ): Promise<{ plan: AgentPlanItem[]; resultSec: number; kept: number } | null> {
    const u = await this.understand(backend);
    if (!u) return null;

    const live = new Set(
      this.history.edl.entries.filter((e): e is Extract<typeof e, { kind: 'segment' }> => e.kind === 'segment').map((e) => e.candidateId),
    );
    const planned = this.candidates.filter((c) => live.has(c.id));
    if (!planned.length) return null;
    const topics = u.topics
      .map((t) => ({ ...t, candidateIds: t.candidateIds.filter((id) => live.has(id)) }))
      .filter((t) => t.candidateIds.length);

    const budget = targetSec - Math.max(1, targetSec * 0.005);
    const build = (keepIds: string[]) => {
      const fastIds = planned.filter((c) => !keepIds.includes(c.id)).map((c) => c.id);
      const ops: MutatingOp[] = [{ op: 'classify', definition: `goal-fit ≤ ${Math.round(targetSec)}s`, keyIds: keepIds }];
      if (keepIds.length) ops.push({ op: 'retime', ids: keepIds, speed: 1 });
      if (fastIds.length) ops.push(mode === 'cut' ? { op: 'cut', ids: fastIds } : { op: 'retime', ids: fastIds, speed: fastSpeed });
      return normalize(applyOps(this.history.edl, ops, {}), this.atoms, this.cfg.postprocess);
    };

    let { keep, reasons, arc } = assembleNarrative(topics, u.verdicts, planned, budget);
    if (!keep.length) return null;

    // Same closed loop as the greedy planner: measure, don't estimate. Drop
    // from the LEAST relevant topic first so the arc survives trimming.
    const relOf = (id: string) => {
      const t = topics.find((x) => x.candidateIds.includes(id));
      return t ? (u.verdicts.get(t.id)?.relevance ?? 0) : 0;
    };
    let normalized = build(keep);
    // Trim non-arc segments first. Ordering purely by relevance discarded the
    // CLOSING beat (0.90) before a higher-scoring mid-video topic (1.00), so
    // the cut ended wherever the budget ran out — undoing the reservation that
    // assembleNarrative had just made.
    const isArc = new Set(arc);
    const weakestFirst = [...keep].sort((a, b) => {
      const aArc = isArc.has(a) ? 1 : 0;
      const bArc = isArc.has(b) ? 1 : 0;
      if (aArc !== bArc) return aArc - bArc;
      return relOf(a) - relOf(b);
    });
    for (const victim of weakestFirst) {
      if (outputDuration(normalized) <= budget || keep.length <= 2) break;
      keep = keep.filter((id) => id !== victim);
      normalized = build(keep);
    }

    this.history.commit(normalized, mode === 'cut' ? `cut to fit ${Math.round(targetSec)}s` : `fit under ${Math.round(targetSec)}s`);
    const keepSet = new Set(keep);
    this.agentPlan = planned
      .filter((c) => mode !== 'cut' || keepSet.has(c.id))
      .map((c) => {
        const t = topics.find((x) => x.candidateIds.includes(c.id));
        const v = t ? u.verdicts.get(t.id) : undefined;
        return {
          id: c.id,
          speed: keepSet.has(c.id) ? 1 : fastSpeed,
          reason: keepSet.has(c.id)
            ? (reasons.get(c.id) ?? `${v?.label ?? 'Relevant'} — kept at 1×`)
            : `${v?.label ?? 'Off-goal'} (relevance ${(v?.relevance ?? 0).toFixed(2)}) — compressed ${fastSpeed}×`,
        };
      });
    return { plan: this.agentPlan, resultSec: outputDuration(this.history.edl), kept: keep.length };
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
        // Repair formatting slips ("c20" → "c020") first, THEN drop anything
        // still unknown — otherwise correct rankings are thrown away as if
        // they were hallucinations.
        const known = new Set(this.digest.entries.map((e) => e.id));
        result.highlights = result.highlights
          .map((h) => ({ ...h, id: canonicalizeId(h.id, known) ?? h.id }))
          .filter((h) => known.has(h.id));
        // Two models can map onto the same segment once repaired.
        const seen = new Set<string>();
        result.highlights = result.highlights.filter((h) => !seen.has(h.id) && seen.add(h.id));
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
  async answer(backend: Backend, question: string, onToken?: (t: string) => void): Promise<string> {
    const summary = this.summaryCache?.summary;
    const ctx = {
      digest: this.digest,
      summary,
      question,
      history: this.log.slice(-5),
      // Follow-ups like "why?" resolve against the conversation + last action.
      conversation: this.chatLog.slice(-8),
      lastAction: this.lastAction ?? undefined,
      goal: this.goal ?? undefined,
    };
    if (onToken && backend.answerStream) {
      try {
        const a = await backend.answerStream(ctx, onToken);
        if (a.trim()) return a.trim();
      } catch {
        /* fall through to the non-streaming path */
      }
    }
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
