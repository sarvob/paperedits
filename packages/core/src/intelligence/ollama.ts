import type { Patch } from '../types.js';
import type { Backend, PlanContext } from './index.js';
import { buildOutboundText, parseModelReply, SYSTEM_PROMPT } from './protocol.js';

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

  async plan(ctx: PlanContext): Promise<Patch> {
    const host = (this.cfg.host ?? 'http://127.0.0.1:11434').replace(/\/$/, '');
    const doFetch = this.cfg.fetchImpl ?? fetch;
    const res = await doFetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        stream: false,
        options: { temperature: 0 },
        format: 'json',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildOutboundText(ctx) },
        ],
      }),
    });
    if (!res.ok) throw new Error(`ollama returned ${res.status} ${res.statusText}`);
    const data = (await res.json()) as { message?: { content?: string } };
    return parseModelReply(ctx.instruction, data.message?.content ?? '');
  }
}
