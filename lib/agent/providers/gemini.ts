import { GoogleGenerativeAI } from '@google/generative-ai';
import type {
  AssistantTurn,
  ChatMessage,
  ChatParams,
  ChatWithToolsParams,
  Provider,
  ProviderConfig,
  ToolCall,
  ToolStopReason,
  ValidationResult,
} from './types';
import { resolveMaxTokens } from './maxTokens';

export class GeminiProvider implements Provider {
  id = 'gemini' as const;
  private client: GoogleGenerativeAI;

  constructor(cfg: ProviderConfig) {
    this.client = new GoogleGenerativeAI(cfg.apiKey);
  }

  async validate(model: string): Promise<ValidationResult> {
    try {
      const m = this.client.getGenerativeModel({ model });
      await m.generateContent('ping');
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  async chat(params: ChatParams): Promise<string> {
    const sys = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const others = params.messages.filter((m) => m.role !== 'system');
    // Root Cause vs Logic: Drop sampling knobs so newer models don't complain about unsupported fields.
    const generationConfig: Record<string, unknown> = {};
    if (params.jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = toGeminiResponseSchema(params.jsonSchema);
    }
    const model = this.client.getGenerativeModel({
      model: params.model,
      ...(sys ? { systemInstruction: sys } : {}),
      ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
    });
    const history = others.slice(0, -1).map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
    const last = others[others.length - 1];
    if (!last) return '';
    const chat = model.startChat({ history });
    const res = await chat.sendMessage(last.content);
    return res.response.text();
  }

  async chatWithTools(params: ChatWithToolsParams): Promise<AssistantTurn> {
    const sys = params.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = toGeminiContents(params.messages.filter((m) => m.role !== 'system'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const modelArgs: any = {
      model: params.model,
      generationConfig: { maxOutputTokens: resolveMaxTokens({ provider: 'gemini', requested: params.maxTokens }) },
      ...(sys ? { systemInstruction: sys } : {}),
    };
    if (params.tools.length) {
      modelArgs.tools = [
        {
          functionDeclarations: params.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiResponseSchema(tool.inputSchema),
          })),
        },
      ];
    }
    const model = this.client.getGenerativeModel(modelArgs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await model.generateContent({ contents } as any, { signal: params.signal });

    const calls = (typeof res.response.functionCalls === 'function' ? res.response.functionCalls() : undefined) ?? [];
    const toolCalls: ToolCall[] = calls.map((call, index) => ({
      id: `${call.name}#${index}`,
      name: call.name,
      input: (call.args ?? {}) as Record<string, unknown>,
    }));
    let text = '';
    try {
      text = res.response.text();
    } catch {
      text = '';
    }
    const finishReason = res.response.candidates?.[0]?.finishReason;
    let stopReason: ToolStopReason = toolCalls.length ? 'tool_use' : mapGeminiFinish(finishReason);
    if (stopReason === 'tool_use' && toolCalls.length === 0) stopReason = 'end_turn';
    return { text: text.trim(), toolCalls, stopReason };
  }
}

function mapGeminiFinish(reason: string | undefined): ToolStopReason {
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

/**
 * Convert neutral history into Gemini `contents`. Gemini keys function responses
 * by name (no ids), so synthesized `name#index` tool-call ids are reduced back to
 * the bare name when emitting functionResponse parts.
 */
function toGeminiContents(messages: ChatMessage[]): Array<Record<string, unknown>> {
  const contents: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const parts = (message.toolResults ?? []).map((result) => ({
        functionResponse: {
          name: result.toolCallId.split('#')[0],
          response: { content: result.content, ...(result.isError ? { error: true } : {}) },
        },
      }));
      contents.push({ role: 'function', parts });
      continue;
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.input ?? {} } });
      }
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }
  return contents;
}

function toGeminiResponseSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiResponseSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const source = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (key === 'additionalProperties') continue;
    if (key === 'type' && Array.isArray(value)) {
      const nonNullTypes = value.filter((t) => t !== 'null');
      out.type = nonNullTypes[0] ?? 'string';
      if (value.includes('null')) out.nullable = true;
      continue;
    }
    out[key] = toGeminiResponseSchema(value);
  }
  return out;
}
