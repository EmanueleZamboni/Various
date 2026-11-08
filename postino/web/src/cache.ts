/** The lists kept on this device between opens, so the app draws instantly (see main.tsx). */
export const CACHE_KEY = 'postino.cache';
/** Bump when the shape of a cached response changes, so old copies are thrown away. */
export const CACHE_VERSION = '1';
export const CACHE_MAX_AGE = 7 * 86_400_000;
export const PERSISTED = ['me', 'accounts', 'folders', 'settings', 'threads', 'groups', 'groupSummary', 'smartUpcoming', 'aiStatus'];

/** localStorage, or a no-op when it is blocked (private mode): the app then just loads normally. */
export function safeStorage(): Storage {
  try {
    const t = '__postino_test';
    window.localStorage.setItem(t, t);
    window.localStorage.removeItem(t);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (k) => mem.get(k) ?? null,
      setItem: (k, v) => void mem.set(k, v),
      removeItem: (k) => void mem.delete(k),
      clear: () => mem.clear(),
      key: () => null,
      length: 0,
    } as Storage;
  }
}

/** Forget everything kept on this device (sign-out, or a different user). */
export function clearCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing kept */
  }
}
