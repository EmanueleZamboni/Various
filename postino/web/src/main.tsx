import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { PersistQueryClientProvider } from '@tanstack/react-query-persist-client';
import { createSyncStoragePersister } from '@tanstack/query-sync-storage-persister';
import { CACHE_KEY, CACHE_MAX_AGE, CACHE_VERSION, PERSISTED, safeStorage } from './cache';
import { BrowserRouter, HashRouter } from 'react-router-dom';

// Demo builds (hosted as a static page) use hash routes so deep links survive without a server.
const Router = import.meta.env.VITE_HASH === '1' ? HashRouter : BrowserRouter;
import App from './App';
import './styles/app.css';
import './styles/gmail.css';
import { initTheme } from './theme';

initTheme();

// An old copy of the app asking for files a new version removed: load the new version once
// instead of showing a blank page.
function reloadOnceForNewVersion() {
  try {
    const last = Number(sessionStorage.getItem('postino.chunkReload') || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('postino.chunkReload', String(Date.now()));
  } catch {
    /* reload anyway */
  }
  window.location.reload();
}
window.addEventListener('vite:preloadError', (e) => {
  e.preventDefault();
  reloadOnceForNewVersion();
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = String((e.reason as Error | undefined)?.message ?? e.reason ?? '');
  if (/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(msg)) reloadOnceForNewVersion();
});

/** Never a blank page: if the app crashes, say so and offer a reload. */
class Crash extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    if (/dynamically imported module|Importing a module script failed|error loading dynamically/i.test(error.message)) reloadOnceForNewVersion();
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="empty" style={{ minHeight: '100vh' }}>
        <h2>Something went wrong</h2>
        <p>{this.state.error.message}</p>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload Postino</button>
      </div>
    );
  }
}

async function boot() {
  if (import.meta.env.VITE_MOCK === '1') {
    const { installMock } = await import('./mock');
    installMock();
  }
  if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.VITE_MOCK !== '1') {
    const { registerSW } = await import('virtual:pwa-register');
    const { useUI } = await import('./store');
    // A new version is applied with a reload, but never while an email is being written.
    const reloadWhenIdle = () => {
      const writing = (s: { compose: unknown; replyOpen: boolean }) => Boolean(s.compose) || s.replyOpen;
      if (!writing(useUI.getState())) return window.location.reload();
      const unsub = useUI.subscribe((s) => {
        if (!writing(s)) {
          unsub();
          window.setTimeout(() => window.location.reload(), 300);
        }
      });
    };
    registerSW({
      immediate: true,
      onNeedReload: reloadWhenIdle,
      // An app left open never navigates, so the browser would almost never look for a new
      // version: ask every 10 minutes and whenever the app comes back to the foreground.
      onRegisteredSW(_url: string, reg: ServiceWorkerRegistration | undefined) {
        if (!reg) return;
        const check = () => void reg.update().catch(() => undefined);
        window.setInterval(check, 10 * 60_000);
        document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
      },
    } as Parameters<typeof registerSW>[0] & { onNeedReload: () => void });
    // A new version took over this page: switch to it (never in the middle of writing).
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) reloadWhenIdle();
      hadController = true;
    });
  }
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 },
    },
  });
  // What the inbox needs to draw itself is kept on this device and shown the moment the app
  // opens (like the Gmail app), then refreshed from the server. Email bodies are not kept here.
  for (const key of PERSISTED) qc.setQueryDefaults([key], { gcTime: CACHE_MAX_AGE });
  const persister = createSyncStoragePersister({ storage: safeStorage(), key: CACHE_KEY, throttleTime: 1500 });
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Crash>
      <PersistQueryClientProvider
        client={qc}
        persistOptions={{
          persister,
          maxAge: CACHE_MAX_AGE,
          buster: CACHE_VERSION,
          dehydrateOptions: { shouldDehydrateQuery: (q) => q.state.status === 'success' && PERSISTED.includes(String(q.queryKey[0])) },
        }}
      >
        <Router>
          <App />
        </Router>
      </PersistQueryClientProvider>
      </Crash>
    </React.StrictMode>,
  );
}

boot();
