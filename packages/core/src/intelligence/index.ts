import type { ReadTools } from '../tools/read.js';
import type { Digest, Edl, Patch, VideoHighlights, VideoSummary } from '../types.js';

/** One prior instruction and the interpretation we derived from it. */
export interface HistoryEntry {
  instruction: string;
  interpretation: string;
}

/**
 * Everything a backend needs to turn one instruction into a patch. The
 * intelligence call receives (digest, current EDL, recent history, new
 * instruction) and returns a *patch* against the current state — never a
 * from-scratch reclassification unless the user asks for one.
 */
export interface PlanContext {
  digest: Digest;
  edl: Edl;
  history: HistoryEntry[];
  instruction: string;
  /** read-only query tools (local, instant) */
  tools: ReadTools;
}

/**
 * A pluggable intelligence backend. Three interchangeable implementations exist:
 * remote (BYO key), local (Ollama), and the no-LLM heuristic. All return the
 * same Patch shape, so the rest of the engine is backend-agnostic.
 */
export interface Backend {
  readonly name: string;
  /** true if this backend sends anything over the network */
  readonly network: boolean;
  plan(ctx: PlanContext): Promise<Patch>;
  /** overview + per-moment one-liners from the digest (optional per backend) */
  summarize?(digest: Digest): Promise<VideoSummary>;
  /** answer a question about the video (chat, not an edit) */
  answer?(ctx: AnswerContext): Promise<string>;
  /** same, but emits tokens as they arrive so the UI can render progressively */
  answerStream?(ctx: AnswerContext, onToken: (t: string) => void): Promise<string>;
  /** ranked key moments with reasons (which segments matter and why) */
  highlights?(digest: Digest): Promise<VideoHighlights>;
  /** summarize a raw text snippet (used for progressive partial summaries) */
  summarizeText?(text: string): Promise<string>;
  /** LLM-as-judge: score a summary against the transcript (debug/metrics) */
  assess?(transcript: string, summary: string): Promise<import('./protocol.js').SummaryAssessment>;
  /**
   * Judge every topic against the user's goal in one bounded call. This is the
   * planner's understanding of the video, and the call most worth pointing at a
   * stronger model — see TOPICS_SYSTEM.
   */
  planTopics?(
    topics: import('./protocol.js').TopicInput[],
    goal: string | undefined,
    totalSec: number,
  ): Promise<ReturnType<typeof import('./protocol.js').parseTopicsReply>>;
}

/** Context for a Q&A turn (a question, not an edit request). */
export interface AnswerContext {
  digest: Digest;
  summary?: string;
  question: string;
  history: HistoryEntry[];
  /** recent chat turns, oldest→newest, so follow-ups like "why?" make sense */
  conversation?: { role: 'user' | 'assistant'; text: string }[];
  /** what the agent last DID to the edit (the referent of "that"/"why") */
  lastAction?: string;
  /** the user's stated job for this video, if they set one */
  goal?: string;
}

export { HeuristicBackend } from './heuristic.js';
export { OllamaBackend } from './ollama.js';
export { RemoteBackend } from './remote.js';
export { CascadeBackend } from './cascade.js';
export { AnthropicBackend } from './anthropic.js';
