import type { Digest, Patch, VideoHighlights, VideoSummary } from '../types.js';
import type { AnswerContext, Backend, PlanContext } from './index.js';
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
  JUDGE_SYSTEM,
  buildJudgePrompt,
  parseAssessment,
  parseModelReply,
  parseSummaryReply,
  SUMMARY_SYSTEM,
  SYSTEM_PROMPT,
} from './protocol.js';

export interface OllamaConfig {
  /** local Ollama endpoint; default http://127.0.0.1:11434 */
  host?: string;
  model: string;
  fetchImpl?: typeof fetch;
}

/**
 * Local backend via an Ollama endpoint. Same op contract as remote, but the
 * "network" here is loopback only — no data leaves the machine, so no outbound
 * gate is required. This is the $0, zero-egress intelligence mode.
 */
export class OllamaBackend implements Backend {
  readonly name = 'ollama';
  readonly network = false; // loopback only

  constructor(private cfg: OllamaConfig) {}

  private async chat(system: string, user: string, json = true): Promise<string> {
    const host = (this.cfg.host ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const res = await doFetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        stream: false,
        // num_ctx: Ollama defaults to a small context (2-4K) which silently
        // TRUNCATES a 30-min video's ~10K-token digest — answers then only
        // "see" the first minutes. 16K covers an hour-long video's digest.
        options: { temperature: json ? 0 : 0.3, num_ctx: 16384 },
        ...(json ? { format: 'json' } : {}),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama returned ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return data.message?.content ?? '';
  }

  async plan(ctx: PlanContext): Promise<Patch> {
    return parseModelReply(ctx.instruction, await this.chat(SYSTEM_PROMPT, buildOutboundText(ctx)));
  }

  async summarize(digest: Digest): Promise<VideoSummary> {
    return parseSummaryReply(await this.chat(SUMMARY_SYSTEM, buildSummaryPrompt(digest)));
  }

  async answer(ctx: AnswerContext): Promise<string> {
    return sanitizeAnswer(await this.chat(ANSWER_SYSTEM, buildAnswerPrompt(ctx), false));
  }

  async highlights(digest: Digest): Promise<VideoHighlights> {
    return parseHighlightsReply(await this.chat(HIGHLIGHTS_SYSTEM, buildHighlightsPrompt(digest)));
  }

  async summarizeText(text: string): Promise<string> {
    return sanitizeAnswer(await this.chat(PARTIAL_SUMMARY_SYSTEM, text, false));
  }

  async assess(transcript: string, summary: string) {
    return parseAssessment(await this.chat(JUDGE_SYSTEM, buildJudgePrompt(transcript, summary)));
  }
}
