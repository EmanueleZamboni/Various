/**
 * "Add to Home screen" support. Chrome fires beforeinstallprompt once, early;
 * we keep the event so the setup wizard can offer a real Install button.
 */
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    for (const l of listeners) l();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    for (const l of listeners) l();
  });
}

export const canPromptInstall = () => deferred !== null;

export const isInstalled = () =>
  typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferred) return 'unavailable';
  const ev = deferred;
  deferred = null;
  await ev.prompt();
  const choice = await ev.userChoice;
  return choice.outcome;
}

export function onInstallChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export type Platform = 'android' | 'ios' | 'desktop';
export const platform = (): Platform => {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  return 'desktop';
};
