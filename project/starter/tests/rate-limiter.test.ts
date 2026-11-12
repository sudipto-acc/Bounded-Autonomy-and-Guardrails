import { afterEach, describe, expect, it, vi } from 'vitest';
import { RateLimiter, withRateLimit } from '../src/utils/rate-limiter.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('RateLimiter', () => {
  it('allows a request when all limits have capacity', () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 5, maxTokensPerMinute: 10_000, maxConcurrent: 2 });
    expect(limiter.canProceed(1000)).toBe(true);
  });

  it('tracks requests and tokens in the sliding window', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 10, maxTokensPerMinute: 10_000, maxConcurrent: 5 });
    await limiter.acquire(1500);
    await limiter.acquire(500);

    expect(limiter.getStatus()).toEqual({
      activeRequests: 2,
      requestsInWindow: 2,
      tokensInWindow: 2000,
      availableRequests: 8,
      availableTokens: 8000
    });
  });

  it('records the actual token usage on release', async () => {
    const limiter = new RateLimiter();
    await limiter.acquire(1000);
    limiter.release(2500);
    expect(limiter.getStatus()).toMatchObject({ activeRequests: 0, tokensInWindow: 2500 });
  });

  it('enforces the concurrent request limit', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 100, maxTokensPerMinute: 1_000_000, maxConcurrent: 1 });
    await limiter.acquire();
    expect(limiter.canProceed()).toBe(false);

    let acquired = false;
    const pending = limiter.acquire().then(() => { acquired = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(acquired).toBe(false);

    limiter.release();
    await pending;
    expect(acquired).toBe(true);
    expect(limiter.getStatus().activeRequests).toBe(1);
  });

  it('never exceeds maxConcurrent when many requests start together', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 100, maxTokensPerMinute: 1_000_000, maxConcurrent: 2 });
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };

    await Promise.all(Array.from({ length: 6 }, () => withRateLimit(limiter, task, 10)));
    expect(peak).toBe(2);
    expect(limiter.getStatus()).toMatchObject({ activeRequests: 0, requestsInWindow: 6 });
  });

  it('enforces the requests-per-minute limit until the window slides', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter({ maxRequestsPerMinute: 2, maxTokensPerMinute: 1_000_000, maxConcurrent: 5 });
    await limiter.acquire();
    limiter.release();
    await limiter.acquire();
    limiter.release();
    expect(limiter.canProceed()).toBe(false);

    let acquired = false;
    const pending = limiter.acquire().then(() => { acquired = true; });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    expect(acquired).toBe(true);
    expect(limiter.getStatus().requestsInWindow).toBe(1);
  });

  it('enforces the tokens-per-minute limit', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 100, maxTokensPerMinute: 1000, maxConcurrent: 5 });
    await limiter.acquire(800);
    limiter.release();
    expect(limiter.canProceed(200)).toBe(true);
    expect(limiter.canProceed(201)).toBe(false);
  });

  it('prunes records older than 60 seconds', async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();
    await limiter.acquire(300);
    limiter.release();
    expect(limiter.getStatus()).toMatchObject({ requestsInWindow: 1, tokensInWindow: 300 });

    vi.advanceTimersByTime(60_001);
    expect(limiter.getStatus()).toMatchObject({ requestsInWindow: 0, tokensInWindow: 0 });
  });

  it('lets a request larger than the token budget through once the window is empty', async () => {
    const limiter = new RateLimiter({ maxTokensPerMinute: 1000 });
    await expect(limiter.acquire(5000)).resolves.toBeUndefined();
    expect(limiter.getStatus().tokensInWindow).toBe(5000);
  });
});

describe('withRateLimit', () => {
  it('returns the result and releases the slot', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    await expect(withRateLimit(limiter, async () => 'ok')).resolves.toBe('ok');
    expect(limiter.getStatus().activeRequests).toBe(0);
  });

  it('releases the slot when the operation fails', async () => {
    const limiter = new RateLimiter({ maxConcurrent: 1 });
    await expect(withRateLimit(limiter, async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(limiter.getStatus().activeRequests).toBe(0);
  });
});
