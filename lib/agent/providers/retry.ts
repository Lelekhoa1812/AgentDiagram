/**
 * Infinite-retry wrapper with exponential backoff + jitter.
 *
 * Honors Retry-After when the underlying error carries one. Otherwise
 * starts at 2s, caps at 60s, and retries forever until the signal aborts.
 *
 * Every retry emits a notice via the supplied listener so the UI can show
 * "Retrying in 8s (attempt 3)" inside the loading animation.
 */

import type { RetryListener } from './types';

export interface RetryError extends Error {
  status?: number;
  retryAfterMs?: number;
}

export interface RetryOptions {
  signal?: AbortSignal;
  onRetry?: RetryListener;
  /** Override default classification — return true if `err` is retryable. */
  isRetryable?: (err: unknown) => boolean;
  baseDelayMs?: number;
  capDelayMs?: number;
}

function defaultIsRetryable(err: unknown): boolean {
  const e = err as RetryError;
  if (typeof e?.status === 'number') {
    if (e.status === 429) return true;
    if (e.status >= 500 && e.status < 600) return true;
  }
  // Network errors / fetch failures
  if (e instanceof TypeError) return true;
  if (typeof e?.message === 'string' && /timeout|ETIMEDOUT|ECONNRESET|fetch failed|network/i.test(e.message))
    return true;
  return false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const base = opts.baseDelayMs ?? 2000;
  const cap = opts.capDelayMs ?? 60_000;
  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    try {
      return await fn();
    } catch (err) {
      if (!isRetryable(err)) throw err;
      attempt++;
      const retryError = err as RetryError;
      const fromHeader = retryError.retryAfterMs;
      const exponential = Math.min(cap, base * 2 ** (attempt - 1));
      const jittered = fromHeader ?? Math.round(exponential * (0.5 + Math.random() * 0.5));
      const reason = retryError.status
        ? `HTTP ${retryError.status}`
        : retryError.message?.slice(0, 80) ?? 'transient error';
      opts.onRetry?.({ attempt, delayMs: jittered, reason });
      await delay(jittered, opts.signal);
    }
  }
}

/** Parse a fetch Response error into a RetryError. */
export async function makeRetryError(res: Response): Promise<RetryError> {
  const err: RetryError = new Error(`${res.status} ${res.statusText}`);
  err.status = res.status;
  const retryAfter = res.headers.get('retry-after');
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) err.retryAfterMs = secs * 1000;
  }
  try {
    const body = await res.text();
    if (body) err.message = `${err.message}: ${body.slice(0, 240)}`;
  } catch {
    /* ignore */
  }
  return err;
}
