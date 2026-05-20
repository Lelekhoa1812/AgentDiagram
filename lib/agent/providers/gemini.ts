import { GoogleGenerativeAI } from '@google/generative-ai';
import type { Provider, ChatParams, ValidationResult, ProviderConfig } from './types';

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
