import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useUI } from '../store';

/** Google's "G", drawn in its four colours, as on Google's own sign-in buttons. */
function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.2C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** "Sign in with Google" for a Gmail mailbox: no app password needed. */
export function GoogleSignInButton({ back, email }: { back: '/welcome' | '/settings/accounts'; email?: string }) {
  const toast = useUI((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api.google.gmail(back, email);
      window.location.href = r.url;
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
      setBusy(false);
    }
  };
  return (
    <button type="button" className="btn google-btn" onClick={() => void go()} disabled={busy}>
      <GoogleG />
      {busy ? 'Opening Google…' : 'Sign in with Google'}
    </button>
  );
}

/** Shows the outcome when Google sends the browser back (?result=…), then cleans the address bar. */
export function useGoogleResult() {
  const loc = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  useEffect(() => {
    const result = new URLSearchParams(loc.search).get('result');
    if (!result) return;
    qc.invalidateQueries({ queryKey: ['accounts'] });
    toast(result === 'gmail-connected' ? { text: 'Gmail connected with Google sign-in', kind: 'success' } : { text: result, kind: 'error' });
    navigate(loc.pathname, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.search]);
}

/** True when this server has a Google sign-in key (Settings → Google), so the button can work. */
export function useGoogleReady(): boolean {
  const { data } = useQuery({ queryKey: ['google'], queryFn: api.google.status, retry: false, staleTime: 60_000 });
  return Boolean(data?.configured);
}
