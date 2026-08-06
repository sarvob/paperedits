import Anthropic from '@anthropic-ai/sdk';
import type { Digest, Patch, VideoHighlights, VideoSummary } from '../types.js';
import type { AnswerContext, Backend, PlanContext } from './index.js';
import type { OutboundGate } from './remote.js';
import {
  ANSWER_SYSTEM,
  buildAnswerPrompt,
  sanitizeAnswer,
  buildHighlightsPrompt,
  buildOutboundText,
  buildSummaryPrompt,
  HIGHLIGHTS_SYSTEM,
  parseHighlightsReply,
  PARTIAL_SUMMARY_SYSTEM,
  parseModelReply,
  parseSummaryReply,
  SUMMARY_SYSTEM,
  SYSTEM_PROMPT,
} from './protocol.js';

export interface AnthropicConfig {
  apiKey: string;
  /** default claude-haiku-4-5 — the cheapest current model, per the product's
   * "powerful judgment, as cheaply as possible" requirement */
  model?: string;
}

/**
 * Backend using the Anthropic API via the official SDK. Only digest-derived
 * text ever crosses the wire (never frames/audio/paths), and every payload
 * passes the outbound-review gate first — same privacy contract as remote.
 */
export class AnthropicBackend implements Backend {
  readonly name = 'anthropic';
  readonly network = true;
  private client: Anthropic;
  private model: string;

  constructor(cfg: AnthropicConfig, private gate: OutboundGate) {
    this.client = new Anthropic({ apiKey: cfg.apiKey });
    this.model = cfg.model || 'claude-haiku-4-5';
  }

  private async ask(system: string, user: string, maxTokens = 2000): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    });
    if (response.stop_reason === 'refusal') throw new Error('model declined the request');
    const block = response.content.find((b) => b.type === 'text');
    return block && block.type === 'text' ? block.text : '';
  }

  async plan(ctx: PlanContext): Promise<Patch> {
    const outbound = buildOutboundText(ctx);
    if (!(await this.gate(outbound))) {
      return { instruction: ctx.instruction, ops: [], interpretation: 'send cancelled by user' };
    }
    return parseModelReply(ctx.instruction, await this.ask(SYSTEM_PROMPT, outbound));
  }

  async summarize(digest: Digest): Promise<VideoSummary> {
    const prompt = buildSummaryPrompt(digest);
    if (!(await this.gate(prompt))) return { summary: '', moments: [] };
    return parseSummaryReply(await this.ask(SUMMARY_SYSTEM, prompt, 3000));
  }

  async highlights(digest: Digest): Promise<VideoHighlights> {
    const prompt = buildHighlightsPrompt(digest);
    if (!(await this.gate(prompt))) return { highlights: [] };
    return parseHighlightsReply(await this.ask(HIGHLIGHTS_SYSTEM, prompt, 2000));
  }

  async summarizeText(text: string): Promise<string> {
    if (!(await this.gate(text))) return '';
    return sanitizeAnswer(await this.ask(PARTIAL_SUMMARY_SYSTEM, text, 300));
  }

  async answer(ctx: AnswerContext): Promise<string> {
    const prompt = buildAnswerPrompt(ctx);
    if (!(await this.gate(prompt))) return 'send cancelled by user';
    return sanitizeAnswer(await this.ask(ANSWER_SYSTEM, prompt, 1500));
  }
}
