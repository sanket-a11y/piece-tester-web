import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { cachedFetch, clearApCatalogCache, CATALOG_TTL_MS } from './ap-catalog-cache.js';

describe('cachedFetch', () => {
  beforeEach(() => clearApCatalogCache());
  afterEach(() => vi.useRealTimers());

  it('serves repeat reads from cache until the TTL passes', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => 'v');
    expect(await cachedFetch('k', load)).toBe('v');
    expect(await cachedFetch('k', load)).toBe('v');
    expect(load).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CATALOG_TTL_MS + 1);
    await cachedFetch('k', load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    let resolve!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>(r => { resolve = r; }));
    const a = cachedFetch('k', load);
    const b = cachedFetch('k', load);
    resolve('v');
    expect(await Promise.all([a, b])).toEqual(['v', 'v']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never caches a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    await expect(cachedFetch('k', load)).rejects.toThrow('boom');
    expect(await cachedFetch('k', load)).toBe('ok');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keys entries separately and clears on demand', async () => {
    const load = vi.fn(async () => 'v');
    await cachedFetch('a', load);
    await cachedFetch('b', load);
    expect(load).toHaveBeenCalledTimes(2);
    clearApCatalogCache();
    await cachedFetch('a', load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('does not repopulate from a load that was in flight when the cache was cleared', async () => {
    let resolve!: (v: string) => void;
    const stale = cachedFetch('k', () => new Promise<string>(r => { resolve = r; }));
    clearApCatalogCache();
    resolve('old');
    await stale;
    expect(await cachedFetch('k', async () => 'new')).toBe('new');
  });
});
