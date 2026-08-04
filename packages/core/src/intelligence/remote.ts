import type { Patch } from '../types.js';
import type { Backend, PlanContext } from './index.js';
import { buildOutboundText, parseModelReply, SYSTEM_PROMPT } from './protocol.js';

/**
 * Gate called with the EXACT text about to leave the machine. Must resolve true
 * to allow the send. This is how the P0 outbound-review pane is wired: the UI
 * shows the text verbatim and the user clicks send/cancel. Default deny-by-
 * omission — if no gate is supplied, nothing is sent.
 */
export type OutboundGate = (text: string) => Promise<boolean>;

export interface RemoteConfig {
  /** OpenAI-compatible chat-completions base, e.g. https://api.openai.com/v1 */
  apiBase: string;
  model: string;
  /**
   * Supplies the API key at call time (from the OS keychain). Never stored on
   * this object and never logged. Requests go DIRECT to the provider — there is
   * no server of ours in the path.
   */
  getApiKey: () => Promise<string>;
  /** injectable for tests; defaults to global fetch */
  fetchImpl?: typeof fetch;
}

export class RemoteBackend implements Backend {
  readonly name = 'remote';
  readonly network = true;

  constructor(private cfg: RemoteConfig, private gate: OutboundGate) {}

  async plan(ctx: PlanContext): Promise<Patch> {
    const outbound = buildOutboundText(ctx);

    // Nothing leaves the machine until the user approves this exact text.
    const approved = await this.gate(outbound);
    if (!approved) {
      return { instruction: ctx.instruction, ops: [], interpretation: 'send cancelled by user' };
    }

    const key = await this.cfg.getApiKey();
    if (!key) throw new Error('no API key available (configure a key in settings / keychain)');

    const doFetch = this.cfg.fetchImpl ?? fetch;
    const res = await doFetch(`${this.cfg.apiBase.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.cfg.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: outbound },
        ],
      }),
    });

    if (!res.ok) throw new Error(`provider returned ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content ?? '';
    return parseModelReply(ctx.instruction, content);
  }
}
