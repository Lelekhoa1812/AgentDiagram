/**
 * Azure AI Foundry provider — uses Azure OpenAI deployment chat completions.
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
    this.endpoint = (cfg.endpoint ?? '').replace(/\/+$/, '');
    if (!this.endpoint) {
      throw new Error('FoundryProvider requires endpoint URL');
    }
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      await this.callChat({ messages: [{ role: 'user', content: 'ping' }], model });
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
    const url = buildFoundryChatUrl(this.endpoint, params.model);
    const body: Record<string, unknown> = {
      // Coding-agent provider payloads stay minimal: no temperature and no max_tokens.
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

function buildFoundryChatUrl(endpoint: string, deployment: string): string {
  const version = process.env.FOUNDRY_API_VERSION ?? process.env.AZURE_OPENAI_API_VERSION ?? '2024-08-01-preview';
  const clean = endpoint.replace(/\/+$/, '');
  if (clean.includes('/chat/completions')) return appendApiVersion(clean, version);
  if (clean.includes('/openai/deployments/')) return appendApiVersion(`${clean}/chat/completions`, version);
  return appendApiVersion(`${clean}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`, version);
}

function appendApiVersion(url: string, version: string): string {
  if (/[?&]api-version=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}api-version=${encodeURIComponent(version)}`;
}
