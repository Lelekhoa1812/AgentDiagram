/**
 * Local Model provider — OpenAI-compatible API.
 * Works with Ollama, LM Studio, llama.cpp, Jan, and any server that exposes
 * an OpenAI-compatible /v1 endpoint.
 */
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

  async chatWithTools(params: ChatWithToolsParams): Promise<AssistantTurn> {
    const maxTokens = resolveMaxTokens({ provider: 'local', requested: params.maxTokens });
    if (params.tools.length) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const baseBody: any = {
          model: params.model,
          messages: buildOpenAIToolMessages(params.messages),
          tools: buildOpenAIToolSpecs(params.tools),
          tool_choice:
            params.toolChoice === 'required' ? 'required' : params.toolChoice === 'none' ? 'none' : 'auto',
        };
        const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
          this.client.chat.completions.create({ ...baseBody, [key]: maxTokens }, { signal: params.signal }),
        );
        return parseOpenAIToolResponse(res);
      } catch {
        // Tool-less local servers reject the `tools` field; fall back to the prompt shim.
      }
    }
    return runToolShimTurn(params.messages, params.tools, async (flattened) => {
      const res = await withMaxTokenKeyRetry(maxTokens, (key) =>
        this.client.chat.completions.create(
          {
            model: params.model,
            messages: flattened.map((m) => ({ role: m.role as 'system' | 'user' | 'assistant', content: m.content })),
            [key]: maxTokens,
          },
          { signal: params.signal },
        ),
      );
      return res.choices[0]?.message?.content ?? '';
    });
  }
}
