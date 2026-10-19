/** In-memory TTL cache for AP piece catalog/metadata reads, with in-flight dedupe. Errors are never cached. */
export const CATALOG_TTL_MS = 10 * 60_000;

interface Entry { value?: unknown; expires: number; pending?: Promise<unknown> }

const entries = new Map<string, Entry>();

export function cachedFetch<T>(key: string, load: () => Promise<T>, ttlMs = CATALOG_TTL_MS): Promise<T> {
  const hit = entries.get(key);
  if (hit?.pending) return hit.pending as Promise<T>;
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.value as T);

  const pending: Promise<T> = load().then(
    value => {
      if (entries.get(key)?.pending === pending) entries.set(key, { value, expires: Date.now() + ttlMs });
      return value;
    },
    err => {
      if (entries.get(key)?.pending === pending) entries.delete(key);
      throw err;
    },
  );
  entries.set(key, { pending, expires: 0 });
  return pending;
}

export function clearApCatalogCache(): void {
  entries.clear();
}
