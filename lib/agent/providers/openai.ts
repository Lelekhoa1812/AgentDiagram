import OpenAI from 'openai';
import type {
  AssistantTurn,
  ChatParams,
  ChatWithToolsParams,
  Provider,
  ProviderConfig,
  ValidationResult,
} from './types';
import { resolveMaxTokens, withMaxTokenKeyRetry } from './maxTokens';
import { buildOpenAIToolMessages, buildOpenAIToolSpecs, parseOpenAIToolResponse } from './openaiCompat';
import { runToolShimTurn } from './toolShim';

export class OpenAIProvider implements Provider {
  id = 'openai' as const;
  private client: OpenAI;

  constructor(cfg: ProviderConfig) {
    this.client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.endpoint });
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      if (usesCompletionsEndpoint(model)) {
        await withMaxTokenKeyRetry(1, (key) =>
          this.client.completions.create({ model, prompt: 'ping', [key]: 1 }),
        );
      } else {
        await this.client.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'ping' }],
        });
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    if (usesCompletionsEndpoint(params.model)) {
      const prompt = toCompletionsPrompt(params.messages, params.jsonSchema);
      const maxTokens = params.jsonSchema ? 4096 : 2048;
      const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
        this.client.completions.create(
          {
            model: params.model,
            prompt,
            [key]: maxTokens,
          },
          { signal: params.signal },
        ),
      );
      return res.choices[0]?.text?.trim() ?? '';
    }

    const messages = params.messages.map((m) => ({ role: m.role, content: m.content }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseBody: any = {
      // Root Cause vs Logic: Sampling overrides can be rejected by modern models, so keep the payload minimal.
      model: params.model,
      messages,
    };
    if (params.jsonSchema) {
      baseBody.response_format = {
        type: 'json_schema',
        json_schema: { name: 'output', schema: params.jsonSchema, strict: true },
      };
    }
    const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
    const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
      this.client.chat.completions.create({ ...baseBody, [key]: maxTokens }, { signal: params.signal }),
    );
    return res.choices[0]?.message?.content ?? '';
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<AssistantTurn> {
    // Codex text models can't use native tools; drive them through the prompt shim.
    if (usesCompletionsEndpoint(params.model)) {
      const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
      return runToolShimTurn(params.messages, params.tools, async (flattened) => {
        const prompt = toCompletionsPrompt(flattened);
        const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
          this.client.completions.create(
            { model: params.model, prompt, [key]: maxTokens },
            { signal: params.signal },
          ),
        );
        return res.choices[0]?.text ?? '';
      });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baseBody: any = {
      model: params.model,
      messages: buildOpenAIToolMessages(params.messages),
    };
    if (params.tools.length) {
      baseBody.tools = buildOpenAIToolSpecs(params.tools);
      baseBody.tool_choice =
        params.toolChoice === 'required' ? 'required' : params.toolChoice === 'none' ? 'none' : 'auto';
    }
    const maxTokens = resolveMaxTokens({ provider: 'openai', requested: params.maxTokens });
    const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
      this.client.chat.completions.create({ ...baseBody, [key]: maxTokens }, { signal: params.signal }),
    );
    return parseOpenAIToolResponse(res);
  }
}

function usesCompletionsEndpoint(model: string): boolean {
  // Root Cause vs Logic: Codex text models are rejected by /chat/completions, so route only those models through the legacy completions API while preserving chat semantics for normal OpenAI models.
  return model.toLowerCase().includes('codex');
}

function toCompletionsPrompt(messages: ChatParams['messages'], jsonSchema?: Record<string, unknown>): string {
  const conversation = messages
    .map((m) => `${m.role.toUpperCase()}:\n${m.content}`)
    .join('\n\n');

  const schemaInstruction = jsonSchema
    ? `\n\nReturn only valid JSON matching this JSON Schema:\n${JSON.stringify(jsonSchema)}`
    : '';

  return `${conversation}${schemaInstruction}\n\nASSISTANT:\n`;
}
