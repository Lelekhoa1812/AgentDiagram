import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../providers/retry';

describe('withRetry', () => {
  it('returns immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 and eventually returns', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls < 3) {
        const err: Error & { status?: number; retryAfterMs?: number } = new Error('Too Many Requests');
        err.status = 429;
        err.retryAfterMs = 10;
        throw err;
      }
      return 'finally ok';
    };
    const notices: Array<{ attempt: number; delayMs: number; reason: string }> = [];
    const result = await withRetry(fn, { onRetry: (n) => notices.push(n), baseDelayMs: 10, capDelayMs: 50 });
    expect(result).toBe('finally ok');
    expect(calls).toBe(3);
    expect(notices.length).toBeGreaterThanOrEqual(2);
    expect(notices[0]?.reason).toContain('429');
  });

  it('throws non-retryable errors immediately', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('bad request'));
    await expect(
      withRetry(fn, {
        isRetryable: () => false,
      }),
    ).rejects.toThrow('bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    const fn = async () => {
      const err: Error & { status?: number } = new Error('rate limit');
      err.status = 429;
      throw err;
    };
    setTimeout(() => ac.abort(), 30);
    await expect(withRetry(fn, { signal: ac.signal, baseDelayMs: 50 })).rejects.toThrow();
  });
});
