export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'foundry';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatParams {
  messages: ChatMessage[];
  model: string;
  /** JSON schema for structured output. Provider adapts to its native equivalent. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  reason: string;
}

export interface ProviderConfig {
  apiKey: string;
  endpoint?: string;
}

export interface Provider {
  id: ProviderId;
  validate(model: string): Promise<ValidationResult>;
  chat(params: ChatParams): Promise<string>;
}

export type RetryListener = (notice: RetryNotice) => void;
