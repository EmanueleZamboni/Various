import { useEffect, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from './api/client';
import { useMe } from './api/hooks';
import { useServerEvents } from './api/events';
import { Login, Setup } from './components/Auth';
import { Shell } from './components/Shell';
import { Toasts } from './components/Toasts';

type AuthState = 'loading' | 'setup' | 'login' | 'in';

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const me = useMe(auth === 'in');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const loc = useLocation();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.setup.status();
        if (!alive) return;
        if (s.needsSetup) return setAuth('setup');
        try {
          await api.auth.me();
          if (alive) setAuth('in');
        } catch (e) {
          if (alive) setAuth(e instanceof ApiError && e.status === 401 ? 'login' : 'login');
        }
      } catch {
        if (alive) setAuth('login');
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Any 401 from the API after login sends the user back to the login screen.
  useEffect(() => {
    if (auth !== 'in') return;
    const unsub = qc.getQueryCache().subscribe((ev) => {
      const err = ev.query.state.error;
      if (err instanceof ApiError && err.status === 401) setAuth('login');
    });
    return unsub;
  }, [auth, qc]);

  useServerEvents(auth === 'in');

  useEffect(() => {
    if (auth === 'setup' && loc.pathname !== '/setup') navigate('/setup', { replace: true });
    if (auth === 'login' && loc.pathname !== '/login') navigate('/login', { replace: true });
    if (auth === 'in' && (loc.pathname === '/login' || loc.pathname === '/setup')) navigate('/inbox', { replace: true });
  }, [auth, loc.pathname, navigate]);

  if (auth === 'loading') return <div className="auth" aria-busy="true" />;

  return (
    <>
      <Routes>
        <Route path="/setup" element={<Setup onDone={() => setAuth('in')} />} />
        <Route path="/login" element={<Login onDone={() => setAuth('in')} />} />
        {auth === 'in' && (
          <>
            <Route path="/" element={<Navigate to="/inbox" replace />} />
            <Route path="/t/:threadId" element={<Shell forcedView="inbox" me={me.data} onLogout={() => setAuth('login')} />} />
            <Route path="/search" element={<Shell me={me.data} onLogout={() => setAuth('login')} />} />
            <Route path="/search/t/:threadId" element={<Shell me={me.data} onLogout={() => setAuth('login')} />} />
            <Route path="/settings/*" element={<Shell me={me.data} onLogout={() => setAuth('login')} />} />
            <Route path="/:view" element={<Shell me={me.data} onLogout={() => setAuth('login')} />} />
            <Route path="/:view/t/:threadId" element={<Shell me={me.data} onLogout={() => setAuth('login')} />} />
          </>
        )}
        <Route path="*" element={<div className="auth" />} />
      </Routes>
      <Toasts />
    </>
  );
}
