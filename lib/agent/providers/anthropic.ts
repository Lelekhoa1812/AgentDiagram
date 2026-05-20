import Anthropic from '@anthropic-ai/sdk';
import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';

export class AnthropicProvider implements Provider {
  id = 'anthropic' as const;
  private client: Anthropic;

  constructor(cfg: ProviderConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.endpoint });
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      await this.client.messages.create({
        model,
        max_tokens: 8,
        messages: [{ role: 'user', content: 'ping' }],
      });
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    const sys = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const others = params.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body: any = {
      // Root Cause vs Logic: Anthropic requires max_tokens even for JSON/tool calls, while sampling overrides can still be model-specific. Keep the required output cap explicit and the rest minimal.
      model: params.model,
      max_tokens: 4096,
      messages: others,
      ...(sys ? { system: sys } : {}),
    };
    if (params.jsonSchema) {
      body.tools = [
        { name: 'emit', description: 'emit structured output', input_schema: params.jsonSchema },
      ];
      body.tool_choice = { type: 'tool', name: 'emit' };
    }
    const res = await this.client.messages.create(body, { signal: params.signal });
    if (params.jsonSchema) {
      const toolUse = res.content.find((c) => c.type === 'tool_use');
      if (toolUse && toolUse.type === 'tool_use') {
        return JSON.stringify(toolUse.input);
      }
    }
    const text = res.content
      .filter((c): c is Anthropic.TextBlock => c.type === 'text')
      .map((c) => c.text)
      .join('');
    return text;
  }
}
