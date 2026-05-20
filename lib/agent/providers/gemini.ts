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
    const model = this.client.getGenerativeModel({
      model: params.model,
      ...(sys ? { systemInstruction: sys } : {}),
      generationConfig: {
        temperature: params.temperature ?? 0.2,
        maxOutputTokens: params.maxTokens ?? 2048,
        ...(params.jsonSchema
          ? {
              responseMimeType: 'application/json',
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              responseSchema: params.jsonSchema as any,
            }
          : {}),
      },
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
