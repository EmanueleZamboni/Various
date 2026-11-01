/**
 * Light or dark: "system" follows the device. The choice is remembered on this device too,
 * so the right colours show before sign-in and before the settings load.
 */
export type ThemePref = 'system' | 'light' | 'dark';
const KEY = 'postino.theme';
const media = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let pref: ThemePref = 'system';

function apply(): void {
  const dark = pref === 'dark' || (pref === 'system' && !!media?.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111214' : '#f6f8fc');
}

export function initTheme(): void {
  try {
    const saved = localStorage.getItem(KEY) as ThemePref | null;
    if (saved === 'light' || saved === 'dark' || saved === 'system') pref = saved;
  } catch {
    /* ignore */
  }
  apply();
  media?.addEventListener('change', apply);
}

export function setTheme(p: ThemePref): void {
  pref = p;
  try {
    localStorage.setItem(KEY, p);
  } catch {
    /* ignore */
  }
  apply();
}
