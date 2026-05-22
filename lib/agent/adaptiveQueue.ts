import type { RetryListener } from './providers';
import type { RetryNotice } from './providers/types';

export interface AdaptiveQueueEvent {
  kind: 'rate-limit' | 'recover';
  concurrency: number;
  delayMs?: number;
  reason?: string;
}

export interface AdaptiveQueueControl {
  signal?: AbortSignal;
  onRetry: RetryListener;
}

export interface AdaptiveQueueOptions {
  initialConcurrency: number;
  minConcurrency?: number;
  maxConcurrency?: number;
  signal?: AbortSignal;
  onRetry?: RetryListener;
  onEvent?: (event: AdaptiveQueueEvent) => void;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function isRateLimitNotice(notice: RetryNotice): boolean {
  return /\b(?:429|rate limit|too many requests)\b/i.test(notice.reason);
}

export async function adaptiveMap<T, R>(
  items: readonly T[],
  opts: AdaptiveQueueOptions,
  worker: (item: T, index: number, control: AdaptiveQueueControl) => Promise<R>,
): Promise<R[]> {
  const minConcurrency = opts.minConcurrency ?? 1;
  const maxConcurrency = Math.max(minConcurrency, opts.maxConcurrency ?? opts.initialConcurrency);
  let currentConcurrency = Math.min(Math.max(opts.initialConcurrency, minConcurrency), maxConcurrency);
  let cooldownUntil = 0;
  let nextIndex = 0;
  let active = 0;
  let completed = 0;
  let successesSinceLimit = 0;
  let settled = false;
  const results: R[] = new Array(items.length);

  // Motivation vs Logic: provider retry handles the failing request, but large repo summarization
  // needs a shared pressure valve so other workers stop launching while the provider cools down.
  return new Promise<R[]>((resolve, reject) => {
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const maybeRecover = (): void => {
      if (currentConcurrency >= maxConcurrency) return;
      if (successesSinceLimit < Math.max(2, currentConcurrency * 2)) return;
      currentConcurrency++;
      successesSinceLimit = 0;
      opts.onEvent?.({ kind: 'recover', concurrency: currentConcurrency });
    };

    const pump = (): void => {
      if (settled) return;
      if (opts.signal?.aborted) {
        fail(new DOMException('Aborted', 'AbortError'));
        return;
      }
      if (completed >= items.length) {
        settled = true;
        resolve(results);
        return;
      }

      const waitMs = Math.max(0, cooldownUntil - Date.now());
      if (waitMs > 0 && active < currentConcurrency && nextIndex < items.length) {
        delay(waitMs, opts.signal).then(pump, fail);
        return;
      }

      while (active < currentConcurrency && nextIndex < items.length) {
        const index = nextIndex++;
        const item = items[index]!;
        active++;
        const control: AdaptiveQueueControl = {
          signal: opts.signal,
          onRetry: (notice) => {
            opts.onRetry?.(notice);
            if (!isRateLimitNotice(notice)) return;
            const nextConcurrency = Math.max(minConcurrency, Math.floor(currentConcurrency / 2));
            currentConcurrency = Math.min(currentConcurrency - 1, nextConcurrency);
            if (currentConcurrency < minConcurrency) currentConcurrency = minConcurrency;
            const cooldownMs = Math.max(1000, Math.min(90_000, notice.delayMs + 1000));
            cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldownMs);
            successesSinceLimit = 0;
            opts.onEvent?.({
              kind: 'rate-limit',
              concurrency: currentConcurrency,
              delayMs: cooldownMs,
              reason: notice.reason,
            });
          },
        };

        worker(item, index, control)
          .then((result) => {
            results[index] = result;
            active--;
            completed++;
            successesSinceLimit++;
            maybeRecover();
            pump();
          })
          .catch(fail);
      }
    };

    pump();
  });
}
