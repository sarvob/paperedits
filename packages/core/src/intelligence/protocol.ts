import { digestToPrompt } from '../digest.js';
import type { Digest, MutatingOp, Op, Patch, VideoHighlights, VideoSummary } from '../types.js';
import type { PlanContext } from './index.js';

/**
 * Shared wire protocol for the LLM backends (remote + Ollama). The model is
 * asked to return a strict JSON object using the op DSL. It returns candidate
 * IDs only — never timestamps — matching the hard contract enforced by
 * validateOps downstream.
 */

export const SYSTEM_PROMPT = `You are the editor's brain for a local-first video editor.
You edit a document (an EDL) about a video by proposing operations. You NEVER
touch pixels and you NEVER invent timestamps.

RULES:
- Refer to segments ONLY by the ids given in the digest (e.g. "c003"). Any other
  id will be rejected.
- Return a PATCH against the CURRENT edl — change only what the instruction asks.
  Do not reclassify from scratch unless explicitly told to.
- Respond with ONLY a JSON object, no prose, of the form:
  {"interpretation": "<one line>", "ops": [ <op>, ... ], "confidence": <0..1>}
- confidence is how sure you are the ops correctly capture the request (0..1).
- If the message is a QUESTION about the video (not an edit request), return
  ops: [] with a low confidence — it will be answered separately.
- Valid ops:
  {"op":"classify","definition":str,"keyIds":[id,...]}
  {"op":"retime","ids":[id,...],"speed":number}
  {"op":"overlay","ids":[id,...],"text":str,"style":"label"|"chapter"|"badge"}
  {"op":"insert","card":{"text":str,"durationSec":number},"beforeId":id}
  {"op":"cut","ids":[id,...]}
  {"op":"audio","action":"mute"|"music"|"duck","ids":[id,...]}
  {"op":"reframe","aspect":"source"|"16:9"|"9:16"|"1:1"}`;

/** Build the exact text payload that will leave the machine (for the review pane). */
export function buildOutboundText(ctx: PlanContext): string {
  const historyBlock = ctx.history
    .slice(-5)
    .map((h) => `- "${h.instruction}" → ${h.interpretation}`)
    .join('\n');

  const edlBlock = ctx.edl.entries
    .map((e) =>
      e.kind === 'segment'
        ? `#${e.index} ${e.candidateId} ${e.class} ${e.speed}×${e.label ? ` "${e.label}"` : ''}${e.pinned ? ' [pinned]' : ''}`
        : `[card] "${e.text}" ${e.durationSec}s`,
    )
    .join('\n');

  return [
    `DIGEST (${ctx.digest.entries.length} segments, ${Math.round(ctx.digest.durationSec)}s):`,
    digestToPrompt(ctx.digest),
    '',
    'CURRENT EDL:',
    edlBlock,
    '',
    historyBlock ? `RECENT INSTRUCTIONS:\n${historyBlock}\n` : '',
    `NEW INSTRUCTION: ${ctx.instruction}`,
  ].join('\n');
}

/** Parse the model's JSON reply into a Patch. Throws on unparseable output. */
export function parseModelReply(instruction: string, raw: string): Patch {
  const json = extractJson(raw);
  const parsed = JSON.parse(json) as { interpretation?: string; ops?: unknown; confidence?: unknown };
  const ops = Array.isArray(parsed.ops) ? (parsed.ops as Op[]) : [];
  const mutating = ops.filter((o): o is MutatingOp => o.op !== 'export');
  const confidence = typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : undefined;
  return {
    instruction,
    ops: mutating,
    interpretation: typeof parsed.interpretation === 'string' ? parsed.interpretation : '(no interpretation)',
    ...(confidence != null ? { confidence } : {}),
  };
}

// ---------------------------------------------------------------------------
// Highlights — ranked key moments with reasons
// ---------------------------------------------------------------------------

export const HIGHLIGHTS_SYSTEM = `You identify the KEY moments of a video from a
digest of its segments. Return ONLY a JSON object:
  {"highlights": [{"id": "<segment id>", "title": "<= 8 word title",
    "why": "<one sentence: why this moment matters>", "score": <0..1>}, ...]}
RULES:
- Select only the genuinely important moments (typically 3-8, not every segment).
- Rank by importance via score (1 = most important).
- Use ONLY the segment ids given. Base everything on the provided speech/objects;
  do not invent content. "why" should be specific to this video, not generic.`;

export function buildHighlightsPrompt(digest: Digest): string {
  return buildSummaryPrompt(digest);
}

export function parseHighlightsReply(raw: string): VideoHighlights {
  const parsed = JSON.parse(extractJson(raw)) as { highlights?: unknown };
  const list = Array.isArray(parsed.highlights) ? parsed.highlights : [];
  const highlights = (list as { id?: string; title?: string; why?: string; score?: number }[])
    .filter((h) => h && typeof h.id === 'string' && typeof h.title === 'string')
    .map((h) => ({
      id: h.id!,
      title: h.title!,
      why: typeof h.why === 'string' ? h.why : '',
      score: typeof h.score === 'number' ? Math.max(0, Math.min(1, h.score)) : 0.5,
    }))
    .sort((a, b) => b.score - a.score);
  return { highlights };
}

// ---------------------------------------------------------------------------
// Q&A — answering questions about the video (not edits)
// ---------------------------------------------------------------------------

export const PARTIAL_SUMMARY_SYSTEM = `You summarize the opening portion of a
video from its transcript, possibly updating an earlier draft. Reply with ONLY
the summary: 1-2 sentences, plain prose. If a draft is provided, revise it to
absorb the new content — do not mention the draft, the transcript, or that this
is partial.`;

export const JUDGE_SYSTEM = `You are a strict evaluator of video summaries.
Given a transcript (possibly truncated) and a summary of that video, score the
summary. Reply with ONLY JSON:
{"faithfulness": 1-10, "coverage": 1-10, "clarity": 1-10, "critique": "one sentence on the biggest weakness"}
faithfulness = no invented facts; coverage = captures the main content;
clarity = readable, concrete, no filler.`;

/** Parsed result of a summary-quality judgement. */
export interface SummaryAssessment {
  faithfulness: number;
  coverage: number;
  clarity: number;
  critique: string;
}

export function parseAssessment(raw: string): SummaryAssessment {
  const j = JSON.parse(raw) as Partial<SummaryAssessment>;
  const n = (v: unknown) => Math.max(1, Math.min(10, Number(v) || 0));
  return { faithfulness: n(j.faithfulness), coverage: n(j.coverage), clarity: n(j.clarity), critique: String(j.critique ?? '').slice(0, 300) };
}

export function buildJudgePrompt(transcript: string, summary: string): string {
  return `TRANSCRIPT (may be truncated):\n${transcript.slice(0, 12000)}\n\nSUMMARY TO EVALUATE:\n${summary}`;
}

export const ANSWER_SYSTEM = `You are the assistant inside a video editor. You
answer questions using the video digest (speech, activity, objects), the
conversation so far, and LAST ACTION — the edit you (the assistant) just
performed. When the user says "why?", "that", or "it", they almost always mean
LAST ACTION or the previous turn — answer about the action, not the video, in
that case. Be concise and specific; cite timestamps (m:ss) when useful. If you
don't have the answer, say so briefly. Plain text, no JSON, no markdown headers.`;

/** Build the Q&A payload: conversation + last action + digest + the question. */
export function buildAnswerPrompt(ctx: {
  digest: Digest;
  summary?: string;
  question: string;
  conversation?: { role: 'user' | 'assistant'; text: string }[];
  lastAction?: string;
  goal?: string;
}): string {
  const convo = (ctx.conversation ?? [])
    .slice(-6)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text}`)
    .join('\n');
  // Context sections are wrapped in tags and the question comes LAST with an
  // explicit answer-only instruction — small models otherwise echo the labels.
  return [
    ctx.goal ? `<user_goal>\n${ctx.goal}\n</user_goal>\n` : '',
    ctx.summary ? `<summary>\n${ctx.summary}\n</summary>\n` : '',
    ctx.lastAction ? `<last_action>\n${ctx.lastAction}\n</last_action>\n` : '',
    convo ? `<conversation>\n${convo}\n</conversation>\n` : '',
    `<digest segments="${ctx.digest.entries.length}" duration_sec="${Math.round(ctx.digest.durationSec)}">`,
    digestToPrompt(ctx.digest),
    `</digest>`,
    '',
    `Question: ${ctx.question}`,
    `Write ONLY the answer, in plain prose. Never repeat, quote, or mention the sections, tags, or labels above.`,
  ].join('\n');
}

/**
 * Strip prompt scaffolding a small model may have echoed into its answer
 * (section labels, raw digest lines, tag fragments). Keeps only real prose.
 */
export function sanitizeAnswer(raw: string): string {
  const lines = raw.split('\n').filter((line) => {
    const l = line.trim();
    if (/^(LAST ACTION|DIGEST|SUMMARY|CONVERSATION|QUESTION)\b/i.test(l)) return false;
    if (/^<\/?(summary|last_action|conversation|digest)/i.test(l)) return false;
    if (/^#\d+\s*\[c\d+\]/.test(l)) return false; // raw digest entry
    if (/\bact=\d\.\d+\s*\|/.test(l)) return false; // digest fields
    return true;
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Video summary (overview + per-moment one-liners)
// ---------------------------------------------------------------------------

export const SUMMARY_SYSTEM = `You summarize a video from a digest of its segments.
Return ONLY a JSON object:
  {"summary": "<1-2 sentence overview of what the whole video is about>",
   "moments": [{"id": "<segment id>", "label": "<= 8 word summary of that moment>"}, ...]}
RULES:
- Use ONLY the segment ids given. Include one moment per segment, in order.
- Labels are terse, specific, human — like chapter titles. No "Segment 1".
- Base everything on the provided speech/objects; do not invent content.`;

/** Build the summary request payload (digest text). */
export function buildSummaryPrompt(digest: Digest): string {
  return [
    `Video is ${Math.round(digest.durationSec)}s, ${digest.entries.length} segments.`,
    digestToPrompt(digest),
  ].join('\n');
}

/** Parse the model's summary JSON; tolerant of missing moments. */
export function parseSummaryReply(raw: string): VideoSummary {
  const parsed = JSON.parse(extractJson(raw)) as { summary?: string; moments?: unknown };
  const moments = Array.isArray(parsed.moments)
    ? (parsed.moments as { id?: string; label?: string }[])
        .filter((m) => m && typeof m.id === 'string' && typeof m.label === 'string')
        .map((m) => ({ id: m.id!, label: m.label! }))
    : [];
  return { summary: typeof parsed.summary === 'string' ? parsed.summary : '', moments };
}

/** Pull the first balanced JSON object out of a possibly-chatty reply. */
function extractJson(raw: string): string {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('model reply contained no JSON object');
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  throw new Error('model reply had an unbalanced JSON object');
}
