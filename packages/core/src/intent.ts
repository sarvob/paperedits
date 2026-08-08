/**
 * What the user meant — decided by a model, never by pattern matching.
 *
 * Routing used to be regex over the message: an action-verb list, a
 * question-word list, a removal-word list. It failed the way keyword rules
 * always fail — on the phrasings nobody enumerated. "so what is this video
 * about" routed as an EDIT because the question word wasn't at position zero,
 * and a `classify` op was silently applied to the user's timeline. The fix
 * before that had been another list. The list is the bug.
 *
 * Intent is semantics, so a model decides it. Deterministic code keeps
 * everything downstream — duration arithmetic, op validation, atom snapping,
 * id repair — because those are engine correctness, not interpretation.
 */

export type Intent =
  /** asking about the video; must never mutate the EDL */
  | { kind: 'question'; confidence: number }
  /** an edit expressed in prose, handed to the op planner */
  | { kind: 'edit'; destructive: boolean; confidence: number }
  /** a target length; `removal` distinguishes "delete the rest" from "speed it up" */
  | { kind: 'duration'; targetSec: number; fastSpeed: number; removal: boolean; confidence: number }
  | { kind: 'command'; command: 'undo' | 'redo'; confidence: number }
  /** answering a proposal the agent put to the user */
  | { kind: 'confirm'; choice: 'first' | 'second' | 'third' | 'cancel'; confidence: number }
  /** we do not know, or the stakes are too high to guess — ask */
  | { kind: 'unclear'; question: string };

export const INTENT_SYSTEM = `You decide what a user of a video editor meant.
Reply with ONLY JSON, one of these shapes:

  {"kind":"question","confidence":0..1}
  {"kind":"edit","destructive":true|false,"confidence":0..1}
  {"kind":"duration","targetSec":<seconds>,"fastSpeed":<number>,"removal":true|false,"confidence":0..1}
  {"kind":"command","command":"undo"|"redo","confidence":0..1}
  {"kind":"confirm","choice":"first"|"second"|"third"|"cancel","confidence":0..1}
  {"kind":"unclear","question":"<one short question back to the user>"}

RULES:
- "question" = they want to KNOW something about the video. Anything asking what
  it is about, what happens, why you did something, what the key points are.
  Leading filler ("so", "ok", "hmm") and typos change nothing. A missing question
  mark changes nothing.
- "edit" = they want the video CHANGED. destructive=true only if footage would be
  permanently removed rather than sped up or relabelled.
- "duration" = they named a target length. targetSec in SECONDS. fastSpeed is the
  speed for non-key parts (default 10). removal=true only if they clearly want the
  rest DELETED rather than compressed.
- "command" = undo/redo in any phrasing ("revert that", "take that back").
- "confirm" = only when a proposal is pending; map their answer to which option.
- "unclear" = you are not confident, OR the action would destroy footage and the
  wording is ambiguous. Prefer this over guessing. Asking costs a second;
  a wrong guess silently changes the user's edit.
- Be decisive on clear cases. Reserve low confidence for genuine ambiguity.`;

export function buildIntentPrompt(
  message: string,
  opts: { conversation?: { role: 'user' | 'assistant'; text: string }[]; pendingProposal?: string } = {},
): string {
  const convo = (opts.conversation ?? [])
    .slice(-4)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 200)}`)
    .join('\n');
  return [
    opts.pendingProposal ? `A PROPOSAL IS AWAITING THEIR ANSWER:\n${opts.pendingProposal}\n` : '',
    convo ? `Recent conversation:\n${convo}\n` : '',
    `The user just said: ${message}`,
  ]
    .filter(Boolean)
    .join('\n');
}

const KINDS = ['question', 'edit', 'duration', 'command', 'confirm', 'unclear'] as const;

export function parseIntent(raw: string): Intent {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('intent reply contained no JSON');
  let depth = 0;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}' && --depth === 0) {
      end = i + 1;
      break;
    }
  }
  const parsed = JSON.parse(raw.slice(start, end < 0 ? undefined : end)) as Record<string, unknown>;
  const kind = String(parsed.kind);
  if (!(KINDS as readonly string[]).includes(kind)) throw new Error(`unknown intent kind: ${kind}`);
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0.7)));

  switch (kind) {
    case 'question':
      return { kind: 'question', confidence };
    case 'edit':
      return { kind: 'edit', destructive: parsed.destructive === true, confidence };
    case 'duration': {
      const targetSec = Number(parsed.targetSec);
      if (!Number.isFinite(targetSec) || targetSec <= 0) {
        return { kind: 'unclear', question: 'How long should the finished video be?' };
      }
      const fastSpeed = Number(parsed.fastSpeed);
      return {
        kind: 'duration',
        targetSec,
        fastSpeed: Number.isFinite(fastSpeed) && fastSpeed > 1 ? fastSpeed : 10,
        removal: parsed.removal === true,
        confidence,
      };
    }
    case 'command':
      return { kind: 'command', command: parsed.command === 'redo' ? 'redo' : 'undo', confidence };
    case 'confirm': {
      const c = String(parsed.choice);
      const choice = (['first', 'second', 'third', 'cancel'] as const).find((x) => x === c) ?? 'cancel';
      return { kind: 'confirm', choice, confidence };
    }
    default:
      return { kind: 'unclear', question: String(parsed.question || 'Could you rephrase that?') };
  }
}

/**
 * Below this, act only if nothing can be damaged. A wrong guess about a question
 * costs a wasted call; a wrong guess about a destructive edit costs footage.
 */
export const CONFIDENT = 0.6;

/** Should this intent be acted on, or put back to the user as a question? */
export function shouldAct(intent: Intent): boolean {
  if (intent.kind === 'unclear') return false;
  const destructive =
    (intent.kind === 'edit' && intent.destructive) || (intent.kind === 'duration' && intent.removal);
  // Destructive actions need real confidence; everything else is recoverable
  // through undo, so a moderate reading is enough to proceed.
  return intent.confidence >= (destructive ? 0.8 : CONFIDENT);
}
