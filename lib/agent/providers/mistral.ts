import type { ProviderConfig } from './types';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider';

const DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

// Motivation vs Logic: Mistral exposes a drop-in OpenAI-compatible chat endpoint, so we reuse the shared path instead of re-implementing request parsing.
export class MistralProvider extends OpenAICompatibleProvider {
  id = 'mistral' as const;

  constructor(cfg: ProviderConfig) {
    super(cfg, DEFAULT_BASE_URL, 'MISTRAL_ENDPOINT');
  }
}
