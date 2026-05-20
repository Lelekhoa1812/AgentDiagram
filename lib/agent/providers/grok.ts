import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';
import { makeRetryError } from './retry';

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';

function normalizeUrl(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/$/, '') : '';
}

export class GrokProvider implements Provider {
  id = 'grok' as const;
  private apiKey: string;
  private baseUrl: string;

  constructor(cfg: ProviderConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl =
      normalizeUrl(cfg.endpoint) ||
      normalizeUrl(process.env.GROK_API_BASE) ||
      normalizeUrl(DEFAULT_BASE_URL);
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      await this.callChat({ model, messages: [{ role: 'user', content: 'ping' }] });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    return this.callChat(params);
  }

  private async callChat(params: ChatParams): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    // Motivation vs Logic: Grok follows OpenAI-style payloads, so keep the body minimal to avoid unsupported sampling knobs.
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
    };
    if (params.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'output', schema: params.jsonSchema, strict: true },
      };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });
    if (!res.ok) {
      throw await makeRetryError(res);
    }
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }
}
