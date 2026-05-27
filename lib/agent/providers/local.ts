/**
 * Local Model provider — OpenAI-compatible API.
 * Works with Ollama, LM Studio, llama.cpp, Jan, and any server that exposes
 * an OpenAI-compatible /v1 endpoint.
 */
import OpenAI from 'openai';
import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';

export class LocalModelProvider implements Provider {
  id = 'local' as const;
  private client: OpenAI;

  constructor(cfg: ProviderConfig) {
    const baseURL = (cfg.endpoint ?? 'http://localhost:11434/v1').replace(/\/$/, '');
    this.client = new OpenAI({
      baseURL,
      apiKey: cfg.apiKey || 'local',
    });
  }

  async validate(_model: string): Promise<ValidationResult> {
    try {
      await this.client.models.list();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    const messages = params.messages.map((m) => ({
      role: m.role as 'system' | 'user' | 'assistant',
      content: m.content,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      // Keep local/OpenAI-compatible payloads minimal: no temperature and no max_tokens.
      model: params.model,
      messages,
    };
    if (params.jsonSchema) {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'output', schema: params.jsonSchema, strict: true },
      };
    }
    const res = await this.client.chat.completions.create(body, {
      signal: params.signal,
    });
    return res.choices[0]?.message?.content ?? '';
  }
}
