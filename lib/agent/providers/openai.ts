import OpenAI from 'openai';
import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';

export class OpenAIProvider implements Provider {
  id = 'openai' as const;
  private client: OpenAI;

  constructor(cfg: ProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.endpoint });
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      await this.client.chat.completions.create({
        model,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    const messages = params.messages.map((m) => ({ role: m.role, content: m.content }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      // Root Cause vs Logic: Sampling overrides can be rejected by modern models, so keep the payload minimal.
      model: params.model,
      messages,
    };
    if (params.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'output', schema: params.jsonSchema, strict: true },
      };
    }
    const res = await this.client.chat.completions.create(body, { signal: params.signal });
    return res.choices[0]?.message?.content ?? '';
  }
}
