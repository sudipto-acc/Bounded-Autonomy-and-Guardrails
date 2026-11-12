import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCodes,
  ReviewError,
  formatError,
  isReviewError,
  withRetry,
  withTimeout
} from '../src/utils/error-handler.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withRetry', () => {
  it('returns the result without retrying when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries failed attempts until one succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockResolvedValue('ok');
    await expect(withRetry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws RETRY_EXHAUSTED with the last error after maxRetries attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new ReviewError('agent crashed', ErrorCodes.AGENT_FAILED));
    const error = await withRetry(fn, 3, 1).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReviewError);
    expect(error).toMatchObject({
      code: ErrorCodes.RETRY_EXHAUSTED,
      metadata: { attempts: 3, lastError: '[AGENT_FAILED] agent crashed', lastErrorCode: ErrorCodes.AGENT_FAILED }
    });
    expect((error as ReviewError).message).toContain('agent crashed');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('waits with exponential backoff plus jitter between attempts', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter = 50ms
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    const result = withRetry(fn, 3, 1000).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // 1st backoff: 1000 * 2^0 + 50
    await vi.advanceTimersByTimeAsync(1049);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(2);

    // 2nd backoff: 1000 * 2^1 + 50
    await vi.advanceTimersByTimeAsync(2049);
    expect(fn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(result).resolves.toMatchObject({ code: ErrorCodes.RETRY_EXHAUSTED });
  });
});

describe('withTimeout', () => {
  it('returns the result when the operation finishes in time', async () => {
    await expect(withTimeout(async () => 'done', 1000)).resolves.toBe('done');
  });

  it('rejects with AGENT_TIMEOUT when the operation takes too long', async () => {
    vi.useFakeTimers();
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 5000));
    const result = withTimeout(slow, 1000, 'Review timed out').catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1000);
    const error = await result;
    expect(error).toBeInstanceOf(ReviewError);
    expect(error).toMatchObject({
      message: 'Review timed out',
      code: ErrorCodes.AGENT_TIMEOUT,
      metadata: { timeoutMs: 1000 }
    });
  });

  it('propagates errors thrown by the operation', async () => {
    await expect(withTimeout(async () => { throw new Error('inner failure'); }, 1000)).rejects.toThrow('inner failure');
  });

  it('clears its timer once the operation settles', async () => {
    vi.useFakeTimers();
    await withTimeout(async () => 'fast', 60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('error helpers', () => {
  it('identifies and formats ReviewErrors', () => {
    const error = new ReviewError('PR not found', ErrorCodes.PR_NOT_FOUND, { prNumber: 99 });
    expect(isReviewError(error)).toBe(true);
    expect(isReviewError(new Error('plain'))).toBe(false);
    expect(formatError(error)).toBe('[PR_NOT_FOUND] PR not found');
    expect(formatError(new Error('plain'))).toBe('plain');
    expect(formatError('text')).toBe('text');
  });
});
