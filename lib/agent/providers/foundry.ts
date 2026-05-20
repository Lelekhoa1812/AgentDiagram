/**
 * Azure AI Foundry provider — uses OpenAI-compatible REST API.
 * User supplies endpoint and custom model deployment name.
 */
import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';
import { makeRetryError } from './retry';

export class FoundryProvider implements Provider {
  id = 'foundry' as const;
  private apiKey: string;
  private endpoint: string;

  constructor(cfg: ProviderConfig) {
    this.apiKey = cfg.apiKey;
    this.endpoint = (cfg.endpoint ?? '').replace(/\/$/, '');
    if (!this.endpoint) {
      throw new Error('FoundryProvider requires endpoint URL');
    }
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      await this.callChat({
        messages: [{ role: 'user', content: 'ping' }],
        model,
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    const res = await this.callChat(params);
    return res;
  }

  private async callChat(params: ChatParams): Promise<string> {
    const url = `${this.endpoint}/openai/deployments/${encodeURIComponent(params.model)}/chat/completions?api-version=2024-08-01-preview`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      // Root Cause vs Logic: Avoid unsupported sampling knobs so Foundry/OpenAI deployments accept the request.
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
        'Content-Type': 'application/json',
        'api-key': this.apiKey,
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
