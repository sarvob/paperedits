import type { Digest, DigestEntry, MutatingOp, Patch, VideoHighlights, VideoSummary } from '../types.js';
import type { AnswerContext, Backend, PlanContext } from './index.js';

/**
 * No-LLM backend. Parses a useful subset of natural language with regex +
 * thresholds so every op remains reachable with zero network traffic. It is the
 * fallback path (on cap/tool failure) and the "$0, no egress" mode — reduced
 * intelligence, not reduced function.
 *
 * Grammar it understands (composed left-to-right, applied as a patch):
 *   - importance:  "key parts", "important bits"  → activity-threshold classify
 *   - speed:       "10x", "6x", "rest at 8x"      → retime skip segments
 *   - keep rule:   "keep anything with the drill at 1x" → object match → key @1×
 *   - labels:      "label the fast parts"         → overlay labels on skip
 *   - cut:         "cut the boring/silent parts"  → cut low-activity segments
 *   - title:       "add a title before segment 3" → insert card
 */
export class HeuristicBackend implements Backend {
  readonly name = 'heuristic';
  readonly network = false;

  /** Deterministic summary (no model): overview from the transcript, per-moment
   * labels from speech/objects. Always available — offline, silent video, etc. */
  async summarize(digest: Digest): Promise<VideoSummary> {
    const allSpeech = digest.entries.map((e) => e.speech).filter(Boolean).join(' ').trim();
    const mins = Math.round(digest.durationSec / 60);
    let summary: string;
    if (allSpeech) {
      const words = allSpeech.split(/\s+/);
      summary = words.slice(0, 28).join(' ') + (words.length > 28 ? '…' : '');
    } else {
      const objs = [...new Set(digest.entries.flatMap((e) => e.objects))];
      summary = `A ${mins ? `${mins}-minute ` : ''}video with no narration${objs.length ? `, showing ${objs.slice(0, 4).join(', ')}` : ''} across ${digest.entries.length} moments.`;
    }
    const moments = digest.entries.map((e) => ({ id: e.id, label: momentLabel(e) }));
    return { summary, moments };
  }

  /** No-model highlights: rank by activity + speech density. The "why" is honest
   * about being signal-based, not semantic — an LLM backend does much better. */
  async highlights(digest: Digest): Promise<VideoHighlights> {
    const scored = digest.entries.map((e) => {
      const speechDensity = Math.min(1, e.speech.split(/\s+/).filter(Boolean).length / 25);
      const score = 0.6 * e.activity + 0.3 * speechDensity + (e.objects.length ? 0.1 : 0);
      return { e, score };
    });
    const top = scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.min(5, Math.max(3, Math.ceil(digest.entries.length / 6))));
    return {
      highlights: top.map(({ e, score }) => ({
        id: e.id,
        title: momentLabel(e),
        why:
          e.activity >= 0.5
            ? 'High on-screen activity here' + (e.objects.length ? ` (${e.objects.slice(0, 2).join(', ')} detected)` : '')
            : 'Dense narration in this section',
        score: Number(score.toFixed(2)),
      })),
    };
  }

  /**
   * Pattern-based Q&A (no model). Deliberately SHORT — a few top moments, never
   * the full list — and honest that it's the degraded path. Real answers come
   * from an LLM backend; this only exists so the chat never goes dark.
   */
  async answer(ctx: AnswerContext): Promise<string> {
    const q = ctx.question.toLowerCase();
    // "why?" after an action → explain the action, never the video.
    if (/^why\b|why (did|was|is)|explain (that|it|the last)/.test(q) && ctx.lastAction) {
      return `Here's what happened: ${ctx.lastAction}`;
    }
    const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const byId = new Map(ctx.digest.entries.map((e) => [e.id, e]));
    const hint = '\n\n(No AI model is active, so this is a rough cut from signal analysis — select Ollama or Anthropic API in the Intelligence panel for real answers.)';

    if (/how long|duration|length/.test(q)) {
      return `The video is ${fmt(ctx.digest.durationSec)} long, across ${ctx.digest.entries.length} segments.`;
    }
    if (/drill|object|show|see|appear/.test(q)) {
      const objs = [...new Set(ctx.digest.entries.flatMap((e) => e.objects))];
      return objs.length ? `Detected objects: ${objs.join(', ')}.` : `No objects were detected (visual detection is not enabled yet).${hint}`;
    }
    // Everything else — "what is this about", "highlights", open questions —
    // gets the same compact shape: one-line gist + top-5 ranked moments.
    const sum = ctx.summary ?? (await this.summarize(ctx.digest)).summary;
    const top = (await this.highlights(ctx.digest)).highlights.slice(0, 5);
    const gist = sum.split(/\s+/).slice(0, 30).join(' ');
    return (
      `${gist}${sum.split(/\s+/).length > 30 ? '…' : ''}\n\nTop moments:\n` +
      top.map((h) => `• ${fmt(byId.get(h.id)?.start ?? 0)} — ${h.title}`).join('\n') +
      hint
    );
  }

  /** No-model partial summary: the opening words, honestly labeled by caller. */
  async summarizeText(text: string): Promise<string> {
    const words = text.replace(/^[\s\S]*?transcript[^:]*:/i, '').trim().split(/\s+/);
    return words.slice(0, 30).join(' ') + (words.length > 30 ? '…' : '');
  }

  /** activity at/above this is "key" when the user asks for important parts */
  activityKeyThreshold = 0.55;
  /** default fast speed when the user says "rest" without a number */
  defaultFastSpeed = 10;

  async plan(ctx: PlanContext): Promise<Patch> {
    const text = ctx.instruction.toLowerCase();
    const ops: MutatingOp[] = [];
    const notes: string[] = [];
    const entries = ctx.digest.entries;

    const keepMatch = text.match(/keep (?:anything|everything|parts?)? ?(?:with|showing|about)? ([\w\s]+?) (?:at|in) ?(\d+(?:\.\d+)?)x/);
    // A speed inside a "keep X at Nx" clause belongs to that rule, not the
    // global fast-section mapping — strip it before reading the global speed.
    const globalText = keepMatch ? text.replace(keepMatch[0], ' ') : text;
    const speed = parseSpeed(globalText);
    const wantsClassify = /\b(key|important|highlight|main)\b/.test(text);
    const wantsLabels = /\blabel|caption|title the\b/.test(text);
    const wantsCut = /\b(cut|remove|drop|delete)\b/.test(text);
    const titleMatch = text.match(/(?:add|insert) (?:a )?(?:title|card|slide)(?: saying| titled)? ?"?([^"]*?)"? (?:before|at) (?:segment |seg )?#?(\d+)/);

    // 1) Classification (importance definition) ------------------------------
    if (wantsClassify || (speed && /\brest|everything else|other\b/.test(text))) {
      const keyIds = entries.filter((e) => e.activity >= this.activityKeyThreshold).map((e) => e.id);
      ops.push({ op: 'classify', definition: ctx.instruction, keyIds });
      notes.push(`${keyIds.length}/${entries.length} segments marked key (activity ≥ ${this.activityKeyThreshold})`);
    }

    // 2) Retime --------------------------------------------------------------
    if (speed != null) {
      // Retime the non-key (skip) segments to the requested speed; keep key @1×.
      const edl = ctx.tools.get_current_edl();
      const skipIds = edl.entries
        .filter((e) => e.kind === 'segment' && e.class === 'skip')
        .map((e) => (e.kind === 'segment' ? e.candidateId : ''))
        .filter(Boolean);
      const targetIds = skipIds.length ? skipIds : entries.map((e) => e.id);
      ops.push({ op: 'retime', ids: targetIds, speed });
      notes.push(`fast sections → ${speed}×`);
      // Make sure key stays 1× if the user (re)set importance in this turn.
      if (wantsClassify) {
        const keyIds = entries.filter((e) => e.activity >= this.activityKeyThreshold).map((e) => e.id);
        if (keyIds.length) ops.push({ op: 'retime', ids: keyIds, speed: 1 });
      }
    }

    // 3) Keep-rule by object detection --------------------------------------
    if (keepMatch) {
      const term = keepMatch[1]!.trim();
      const keepSpeed = Number(keepMatch[2]);
      const matched = entries.filter(
        (e) => e.objects.some((o) => o.toLowerCase().includes(term)) || e.speech.toLowerCase().includes(term),
      );
      if (matched.length) {
        const ids = matched.map((e) => e.id);
        ops.push({ op: 'retime', ids, speed: keepSpeed });
        notes.push(`${matched.length} segment(s) matching "${term}" pinned to ${keepSpeed}×`);
      } else {
        notes.push(`no segments matched "${term}"`);
      }
    }

    // 4) Labels on fast sections --------------------------------------------
    if (wantsLabels) {
      const fast = entries.filter((e) => e.activity < this.activityKeyThreshold);
      for (const e of fast) {
        ops.push({ op: 'overlay', ids: [e.id], text: labelFor(e), style: 'label' });
      }
      if (fast.length) notes.push(`${fast.length} labels written for fast sections`);
    }

    // 5) Cut low-activity ----------------------------------------------------
    if (wantsCut && !speed) {
      const dead = entries.filter((e) => e.activity < 0.15);
      if (dead.length) {
        ops.push({ op: 'cut', ids: dead.map((e) => e.id) });
        notes.push(`${dead.length} near-silent segment(s) cut`);
      }
    }

    // 6) Title slide ---------------------------------------------------------
    if (titleMatch) {
      const cardText = (titleMatch[1] || 'Title').trim() || 'Title';
      const segNo = Number(titleMatch[2]);
      const anchor = entries.find((e) => e.index === segNo);
      if (anchor) {
        ops.push({ op: 'insert', card: { text: cardText, durationSec: 6 }, beforeId: anchor.id });
        notes.push(`title card "${cardText}" before #${segNo}`);
      }
    }

    return {
      instruction: ctx.instruction,
      ops,
      interpretation: notes.length ? notes.join('; ') : 'no actionable instruction recognized',
    };
  }
}

/** Extract a speed like "10x", "6 x", "1.5x" (returns the LAST one mentioned). */
function parseSpeed(text: string): number | null {
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*x\b/g)];
  if (!matches.length) return null;
  return Number(matches[matches.length - 1]![1]);
}

/** One-line moment label from speech first, else objects, else activity. */
function momentLabel(e: DigestEntry): string {
  if (e.caption) return e.caption;
  const speech = e.speech.split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
  if (speech) return speech + (e.speech.split(/\s+/).length > 8 ? '…' : '');
  if (e.objects.length) return e.objects.slice(0, 3).join(', ');
  return e.activity >= 0.5 ? 'Active section' : 'Quiet section';
}

/** Deterministic 3-word-ish label from a digest entry (no LLM). */
function labelFor(e: DigestEntry): string {
  if (e.objects.length) return e.objects.slice(0, 2).join(' + ');
  const words = e.speech.split(/\s+/).filter(Boolean).slice(0, 3).join(' ');
  return words || 'skipping ahead';
}
