import { OpenAIProvider } from './openai';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { FoundryProvider } from './foundry';
import { GrokProvider } from './grok';
import type { Provider, ProviderId, ProviderConfig, ChatParams, ChatMessage, RetryListener, ValidationResult } from './types';
import { defaultIsRetryable, withRetry, type RetryError } from './retry';

export {
  OPENAI_MODELS,
  ANTHROPIC_MODELS,
  GEMINI_MODELS,
  GROK_MODELS,
  PROVIDER_DEFAULTS,
  getProviderDefaultModel,
} from '../utils/provider-models';
export const PROVIDER_ENV: Record<ProviderId, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'CLAUDE_API_KEY',
  gemini: 'GEMINI_API_KEY',
  foundry: 'FOUNDRY_API_KEY',
  grok: 'GROK_API_KEY',
};

export function getDefaultProvider(): ProviderId {
  const env = process.env.AGENTDIAGRAM_DEFAULT_PROVIDER?.toLowerCase();
  if (env === 'openai' || env === 'anthropic' || env === 'gemini' || env === 'foundry' || env === 'grok') {
    return env;
  }
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
    case 'grok':
      return new GrokProvider(cfg);
  }
}

export interface ProviderSession {
  id: ProviderId;
  model: string;
  endpoint?: string;
  apiKey: string;
}

/** Wraps provider validation with the same transient-error retry policy as chat calls. */
export async function validateWithRetry(
  session: ProviderSession,
  opts: {
    signal?: AbortSignal;
    onRetry?: RetryListener;
  } = {},
): Promise<ValidationResult> {
  const provider = makeProvider(session.id, { apiKey: session.apiKey, endpoint: session.endpoint });
  return withRetry(
    async () => {
      const result = await provider.validate(session.model);
      if (!result.ok) {
        const err: RetryError = new Error(result.error ?? 'Provider validation failed');
        if (defaultIsRetryable(err)) throw err;
      }
      return result;
    },
    { signal: opts.signal, onRetry: opts.onRetry },
  );
}

/** Wraps a provider call with infinite retry + cancellation. */
export async function chatWithRetry(
  session: ProviderSession,
  messages: ChatMessage[],
  opts: {
    signal?: AbortSignal;
    onRetry?: RetryListener;
    jsonSchema?: Record<string, unknown>;
  } = {},
): Promise<string> {
  const provider = makeProvider(session.id, { apiKey: session.apiKey, endpoint: session.endpoint });
  return withRetry(
    () => {
      // Motivation vs Logic: Keep payloads minimal so providers don't reject unsupported sampling overrides.
      const params: ChatParams = {
        model: session.model,
        messages,
        signal: opts.signal,
        jsonSchema: opts.jsonSchema,
      };
      return provider.chat(params);
    },
    { signal: opts.signal, onRetry: opts.onRetry },
  );
}

export type { Provider, ProviderId, ProviderConfig, ChatMessage, ChatParams, RetryListener, ValidationResult };
