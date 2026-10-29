import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, HashRouter } from 'react-router-dom';

// Demo builds (hosted as a static page) use hash routes so deep links survive without a server.
const Router = import.meta.env.VITE_HASH === '1' ? HashRouter : BrowserRouter;
import App from './App';
import './styles/app.css';

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
      if (!useUI.getState().compose) return window.location.reload();
      const unsub = useUI.subscribe((s) => {
        if (!s.compose) {
          unsub();
          window.setTimeout(() => window.location.reload(), 300);
        }
      });
    };
    registerSW({ immediate: true, onNeedReload: reloadWhenIdle } as Parameters<typeof registerSW>[0] & { onNeedReload: () => void });
  }
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 10_000 },
    },
  });
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <QueryClientProvider client={qc}>
        <Router>
          <App />
        </Router>
      </QueryClientProvider>
    </React.StrictMode>,
  );
}

boot();
