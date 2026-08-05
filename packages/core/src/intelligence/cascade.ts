import { validateOps } from '../validate.js';
import type { Digest, Patch, VideoHighlights, VideoSummary } from '../types.js';
import type { AnswerContext, Backend, PlanContext } from './index.js';

export interface CascadeStep {
  backend: Backend;
  /** display label, e.g. the model name */
  label: string;
}

/**
 * Runs an ordered list of backends cheapest → most capable. The cheap model
 * goes first; if its answer is low-confidence or produces invalid/empty ops for
 * an edit, we escalate to the next model. The final model's result is always
 * accepted. This keeps most turns cheap while still handling the hard ones.
 */
export class CascadeBackend implements Backend {
  readonly name = 'cascade';
  readonly network: boolean;

  constructor(private steps: CascadeStep[], private threshold = 0.6) {
    if (!steps.length) throw new Error('cascade needs at least one backend');
    this.network = steps.some((s) => s.backend.network);
  }

  async plan(ctx: PlanContext): Promise<Patch> {
    let last: Patch | null = null;
    for (let i = 0; i < this.steps.length; i++) {
      const step = this.steps[i]!;
      const isLast = i === this.steps.length - 1;
      let patch: Patch;
      try {
        patch = await step.backend.plan(ctx);
      } catch (err) {
        if (isLast) throw err;
        continue; // model failed → escalate
      }
      last = patch;

      // No ops → treat as a question (handled by the Q&A path), don't escalate.
      if (patch.ops.length === 0) return this.tag(patch, step.label);

      const valid = validateOps(patch.ops, ctx.digest, ctx.edl).length === 0;
      const confident = (patch.confidence ?? (valid ? 0.7 : 0)) >= this.threshold;
      if (isLast || (valid && confident)) {
        return this.tag(patch, step.label, i > 0);
      }
      // else: escalate to the next, more capable model
    }
    return last!;
  }

  private tag(patch: Patch, label: string, escalated = false): Patch {
    const conf = patch.confidence != null ? ` ${Math.round(patch.confidence * 100)}%` : '';
    return {
      ...patch,
      interpretation: `[${label}${conf}${escalated ? ' ↑' : ''}] ${patch.interpretation}`,
    };
  }

  /** Use the most capable model that implements the capability. */
  private capable(pick: (b: Backend) => boolean): Backend | null {
    for (let i = this.steps.length - 1; i >= 0; i--) if (pick(this.steps[i]!.backend)) return this.steps[i]!.backend;
    return null;
  }

  async summarize(digest: Digest): Promise<VideoSummary> {
    const b = this.capable((x) => !!x.summarize);
    if (!b?.summarize) throw new Error('no backend can summarize');
    return b.summarize(digest);
  }

  async answer(ctx: AnswerContext): Promise<string> {
    const b = this.capable((x) => !!x.answer);
    if (!b?.answer) throw new Error('no backend can answer');
    return b.answer(ctx);
  }

  async highlights(digest: Digest): Promise<VideoHighlights> {
    const b = this.capable((x) => !!x.highlights);
    if (!b?.highlights) throw new Error('no backend can rank highlights');
    return b.highlights(digest);
  }
}
