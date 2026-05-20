import type { ProviderId } from './providers/types';

export const OPENAI_MODELS = [
  'gpt-5.5',
  'gpt-5.3-codex',
  'gpt-5.4-mini',
  'gpt-4o',
  'gpt-5-nano',
] as const;

export const ANTHROPIC_MODELS = ['opus-4.7', 'sonnet-4.6', 'haiku-4.5'] as const;

export const GEMINI_MODELS = ['gemini-3.1-pro', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'] as const;
export const GROK_MODELS = ['grok-3', 'grok-3-mini', 'grok-2-1212', 'grok-2-vision-1212'] as const;

export const PROVIDER_DEFAULTS: Record<ProviderId, string> = {
  openai: 'gpt-5.5',
  anthropic: 'opus-4.7',
  gemini: 'gemini-3.1-pro',
  foundry: '',
  grok: 'grok-3',
};

export const PROVIDER_MODEL_ENV: Record<ProviderId, string> = {
  openai: 'OPENAI_MODEL',
  anthropic: 'CLAUDE_MODEL',
  gemini: 'GEMINI_MODEL',
  foundry: 'FOUNDRY_MODEL',
  grok: 'GROK_MODEL',
};

export function getProviderDefaultModel(provider: ProviderId): string {
  const envVar = PROVIDER_MODEL_ENV[provider];
  const value = envVar ? process.env[envVar]?.trim() : '';
  // Motivation vs Logic: wire .env overrides into the default so users can preload a model that actually exists for their key.
  return value || PROVIDER_DEFAULTS[provider];
}
