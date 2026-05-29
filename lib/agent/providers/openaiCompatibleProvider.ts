import type {
  AssistantTurn,
  ChatParams,
  ChatWithToolsParams,
  Provider,
  ProviderConfig,
  ProviderId,
  ValidationResult,
} from './types';
import { resolveMaxTokens } from './maxTokens';
import { buildOpenAIToolMessages, buildOpenAIToolSpecs, parseOpenAIToolResponse } from './openaiCompat';
import { makeRetryError } from './retry';

function normalizeUrl(value?: string): string {
  const trimmed = value?.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export abstract class OpenAICompatibleProvider implements Provider {
  abstract id: ProviderId;
  protected readonly apiKey: string;
  protected readonly baseUrl: string;

  constructor(cfg: ProviderConfig, defaultBase: string, envBase?: string) {
    this.apiKey = cfg.apiKey;
    const override = normalizeUrl(cfg.endpoint) || (envBase ? normalizeUrl(process.env[envBase]) : '');
    this.baseUrl = override || defaultBase;
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
    // Motivation vs Logic: These providers expose an OpenAI-compatible chat endpoint, so reuse one fetch path instead of duplicating schema handling.
    const url = `${this.baseUrl}/chat/completions`;
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
    if (!res.ok) throw await makeRetryError(res);
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? '';
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<AssistantTurn> {
    const url = `${this.baseUrl}/chat/completions`;
    const body: Record<string, unknown> = {
      model: params.model,
      messages: buildOpenAIToolMessages(params.messages),
      max_tokens: resolveMaxTokens({ provider: this.id, requested: params.maxTokens }),
    };
    if (params.tools.length) {
      body.tools = buildOpenAIToolSpecs(params.tools);
      body.tool_choice =
        params.toolChoice === 'required' ? 'required' : params.toolChoice === 'none' ? 'none' : 'auto';
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
    if (!res.ok) throw await makeRetryError(res);
    return parseOpenAIToolResponse(await res.json());
  }
}
