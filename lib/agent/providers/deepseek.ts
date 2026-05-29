import type { ProviderConfig } from './types';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';

// Motivation vs Logic: DeepSeek NLU also mirrors OpenAI's chat contract, so the shared helper avoids duplicate tool/schema plumbing.
export class DeepSeekProvider extends OpenAICompatibleProvider {
  id = 'deepseek' as const;

  constructor(cfg: ProviderConfig) {
    super(cfg, DEFAULT_BASE_URL, 'DEEPSEEK_ENDPOINT');
  }
}
