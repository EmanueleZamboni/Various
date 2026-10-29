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

const SIGNED_IN_KEY = 'postino.signedIn';
function wasSignedIn(): boolean {
  try {
    return localStorage.getItem(SIGNED_IN_KEY) === '1';
  } catch {
    return false;
  }
}
function rememberSignedIn(v: boolean): void {
  try {
    if (v) localStorage.setItem(SIGNED_IN_KEY, '1');
    else localStorage.removeItem(SIGNED_IN_KEY);
  } catch {
    // storage blocked: nothing to remember
  }
}

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
          if (!alive) return;
          rememberSignedIn(true);
          setAuth('in');
        } catch (e) {
          if (!alive) return;
          if (e instanceof ApiError && e.status === 401) {
            rememberSignedIn(false);
            setAuth('login');
          } else {
            // Server unreachable (offline, or the VM restarting): keep showing the last
            // synced mail when this browser was signed in before; the offline bar explains.
            setAuth(wasSignedIn() ? 'in' : 'login');
          }
        }
      } catch {
        if (alive) setAuth(wasSignedIn() ? 'in' : 'login');
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
      if (err instanceof ApiError && err.status === 401) {
        rememberSignedIn(false);
        setAuth('login');
      }
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
        <Route path="/setup" element={<Setup onDone={() => { rememberSignedIn(true); setAuth('in'); }} />} />
        <Route path="/login" element={<Login onDone={() => { rememberSignedIn(true); setAuth('in'); }} />} />
        {auth === 'in' && (
          <>
            <Route path="/" element={<Navigate to="/inbox" replace />} />
            <Route path="/t/:threadId" element={<Shell forcedView="inbox" me={me.data} onLogout={() => { rememberSignedIn(false); setAuth('login'); }} />} />
            <Route path="/search" element={<Shell me={me.data} onLogout={() => { rememberSignedIn(false); setAuth('login'); }} />} />
            <Route path="/search/t/:threadId" element={<Shell me={me.data} onLogout={() => { rememberSignedIn(false); setAuth('login'); }} />} />
            <Route path="/settings/*" element={<Shell me={me.data} onLogout={() => { rememberSignedIn(false); setAuth('login'); }} />} />
            <Route path="/:view" element={<Shell me={me.data} onLogout={() => { rememberSignedIn(false); setAuth('login'); }} />} />
            <Route path="/:view/t/:threadId" element={<Shell me={me.data} onLogout={() => { rememberSignedIn(false); setAuth('login'); }} />} />
          </>
        )}
        <Route path="*" element={<div className="auth" />} />
      </Routes>
      <Toasts />
    </>
  );
}
