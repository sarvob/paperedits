import { digestToPrompt } from '../digest.js';
import type { MutatingOp, Op, Patch } from '../types.js';
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
  {"interpretation": "<one line>", "ops": [ <op>, ... ]}
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
  const parsed = JSON.parse(json) as { interpretation?: string; ops?: unknown };
  const ops = Array.isArray(parsed.ops) ? (parsed.ops as Op[]) : [];
  const mutating = ops.filter((o): o is MutatingOp => o.op !== 'export');
  return {
    instruction,
    ops: mutating,
    interpretation: typeof parsed.interpretation === 'string' ? parsed.interpretation : '(no interpretation)',
  };
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
