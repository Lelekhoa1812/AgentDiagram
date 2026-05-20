import { z } from 'zod';
import { chatWithRetry, type ChatMessage, type ProviderSession, type RetryListener } from './providers';
import { withRetry } from './providers/retry';

interface StructuredOutputOptions<T> {
  signal?: AbortSignal;
  onRetry?: RetryListener;
  jsonSchema: Record<string, unknown>;
  schema: z.ZodType<T>;
  parse?: (raw: unknown) => T;
}

class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

function summarizeError(err: unknown): string {
  if (err instanceof z.ZodError) return err.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('; ');
  if (err instanceof Error) return err.message;
  return String(err);
}

function snippet(value: string, max = 1800): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n...[truncated ${trimmed.length - max} chars]`;
}

function firstJsonSlice(raw: string): string {
  const start = raw.search(/[\[{]/);
  if (start < 0) return raw.trim();

  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']');
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) break;
      if (stack.length === 0) return raw.slice(start, i + 1);
    }
  }

  return raw.slice(start).trim();
}

export function parseStructuredJson(raw: string): unknown {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return JSON.parse(firstJsonSlice(cleaned));
  }
}

function messagesWithRepairFeedback(messages: ChatMessage[], failure: StructuredOutputError | null): ChatMessage[] {
  if (!failure) return messages;
  return [
    ...messages,
    {
      role: 'user',
      content:
        'Your previous response could not be parsed or validated as the required JSON schema. ' +
        'Retry now with exactly one valid JSON value, no markdown fences, no prose, and no second JSON object.\n\n' +
        `Error: ${failure.message}\n\nPrevious response excerpt:\n${snippet(failure.raw)}`,
    },
  ];
}

export async function chatStructuredWithRetry<T>(
  session: ProviderSession,
  messages: ChatMessage[],
  opts: StructuredOutputOptions<T>,
): Promise<T> {
  let lastFailure: StructuredOutputError | null = null;

  return withRetry(
    async () => {
      const raw = await chatWithRetry(session, messagesWithRepairFeedback(messages, lastFailure), {
        signal: opts.signal,
        onRetry: opts.onRetry,
        jsonSchema: opts.jsonSchema,
      });
      try {
        const parsed = parseStructuredJson(raw);
        return opts.parse ? opts.parse(parsed) : opts.schema.parse(parsed);
      } catch (err) {
        // Root Cause vs Logic: provider JSON mode is not uniform across models; some return valid JSON followed by prose or a second object, and validation failures happened after provider retries. Treat malformed structured output as retryable, with feedback, so generation continues until aborted.
        lastFailure = new StructuredOutputError(summarizeError(err), raw);
        throw lastFailure;
      }
    },
    {
      signal: opts.signal,
      onRetry: opts.onRetry,
      isRetryable: (err) => err instanceof StructuredOutputError,
      baseDelayMs: 1000,
      capDelayMs: 15_000,
    },
  );
}
