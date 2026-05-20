import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { FoundryProvider } from './foundry';
import type { Provider, ProviderId, ProviderConfig, ChatParams, ChatMessage, RetryListener } from './types';
import { withRetry } from './retry';

export const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'gpt-4o',
  'gpt-5-nano',
] as const;

export const ANTHROPIC_MODELS = ['opus-4.7', 'sonnet-4.6', 'haiku-4.5'] as const;

export const GEMINI_MODELS = ['gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'] as const;

export const PROVIDER_DEFAULTS: Record<ProviderId, string> = {
  openai: 'gpt-5.5',
  anthropic: 'opus-4.7',
  gemini: 'gemini-3.1-pro',
  foundry: '',
};

export const PROVIDER_ENV: Record<ProviderId, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'CLAUDE_API_KEY',
  gemini: 'GEMINI_API_KEY',
  foundry: 'FOUNDRY_API_KEY',
};

export function getDefaultProvider(): ProviderId {
  const env = process.env.AGENTDIAGRAM_DEFAULT_PROVIDER?.toLowerCase();
  if (env === 'openai' || env === 'anthropic' || env === 'gemini' || env === 'foundry') return env;
  return 'openai';
}

export function makeProvider(id: ProviderId, cfg: ProviderConfig): Provider {
  switch (id) {
    case 'openai':
      return new OpenAIProvider(cfg);
    case 'anthropic':
      return new AnthropicProvider(cfg);
    case 'gemini':
      return new GeminiProvider(cfg);
    case 'foundry':
      return new FoundryProvider(cfg);
  }
}

export interface ProviderSession {
  id: ProviderId;
  model: string;
  endpoint?: string;
  apiKey: string;
}

/** Wraps a provider call with infinite retry + cancellation. */
export async function chatWithRetry(
  session: ProviderSession,
  messages: ChatMessage[],
  opts: {
    signal?: AbortSignal;
    onRetry?: RetryListener;
    jsonSchema?: Record<string, unknown>;
    temperature?: number;
    maxTokens?: number;
  } = {},
): Promise<string> {
  const provider = makeProvider(session.id, { apiKey: session.apiKey, endpoint: session.endpoint });
  return withRetry(
    () => {
      const params: ChatParams = {
        model: session.model,
        messages,
        signal: opts.signal,
        temperature: opts.temperature,
        maxTokens: opts.maxTokens,
        jsonSchema: opts.jsonSchema,
      };
      return provider.chat(params);
    },
    { signal: opts.signal, onRetry: opts.onRetry },
  );
}

export type { Provider, ProviderId, ProviderConfig, ChatMessage, ChatParams, RetryListener };
