import type { ProviderConfig } from './types';
import { OpenAICompatibleProvider } from './openaiCompatibleProvider';

const DEFAULT_BASE_URL = 'https://nvidia.com';

// Motivation vs Logic: Nvidia's NIM exposes the same OpenAI-compatible tooling as Foundry, so we reuse the shared path to stay consistent.
export class NvidiaProvider extends OpenAICompatibleProvider {
  id = 'nvidia' as const;

  constructor(cfg: ProviderConfig) {
    super(cfg, DEFAULT_BASE_URL, 'NVIDIA_ENDPOINT');
  }
}
