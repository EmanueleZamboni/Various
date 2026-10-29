import { useEffect, useState, type FormEvent } from 'react';
import { startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, ApiError } from '../api/client';
import { Icon } from '../icons';

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Icon name="mail" size={15} />
      </span>
      <span className="brand-name">Postino</span>
    </div>
  );
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (pw.length < 10) return setErr('Use at least 10 characters. A sentence works well.');
    if (pw !== pw2) return setErr('The two passwords do not match.');
    setBusy(true);
    try {
      await api.setup.create(pw);
      onDone();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the password.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <div>
          <h1>Welcome to Postino</h1>
          <p className="help">First, a password for Postino itself: it protects every mailbox you connect. A long sentence you can remember works best. Your mailboxes come next.</p>
        </div>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="setup-pw">Password</label>
            <input id="setup-pw" className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </div>
          <div className="field">
            <label htmlFor="setup-pw2">Repeat it</label>
            <input id="setup-pw2" className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </div>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy}>
            {busy ? 'Saving' : 'Create password'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [totp, setTotp] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const canPasskey = typeof window !== 'undefined' && browserSupportsWebAuthn();
  const [passkeyHint, setPasskeyHint] = useState(() => {
    try {
      return localStorage.getItem('postino.passkey') === '1';
    } catch {
      return false;
    }
  });
  const usePasskey = async () => {
    setErr('');
    setBusy(true);
    try {
      const options = await api.passkeys.loginOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.passkeys.loginVerify(response);
      try {
        localStorage.setItem('postino.passkey', '1');
      } catch {
        /* ignore */
      }
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_passkeys') {
        setPasskeyHint(false);
        setErr('No fingerprint login set up yet. Sign in with your password, then add it in Settings → Security.');
      } else if ((e as Error).name === 'NotAllowedError') setErr('Fingerprint sign-in was cancelled.');
      else setErr(e instanceof ApiError ? e.message : 'Fingerprint sign-in did not work. Use your password.');
    } finally {
      setBusy(false);
    }
  };
  // Devices that already used a passkey here go straight to the fingerprint prompt.
  useEffect(() => {
    if (passkeyHint && canPasskey) void usePasskey();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.auth.login(pw, needTotp ? totp : undefined);
      onDone();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'totp_required') {
        setNeedTotp(true);
        if (totp) setErr('That code did not work. Codes change every 30 seconds.');
      } else if (e instanceof ApiError && e.status === 429) setErr('Too many tries. Wait a minute and try again.');
      else setErr(e instanceof ApiError && e.status === 401 ? 'Wrong password.' : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auth">
      <div className="auth-card">
        <Brand />
        <h1>Welcome back</h1>
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="login-pw">Password</label>
            <input id="login-pw" className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          </div>
          {needTotp && (
            <div className="field">
              <label htmlFor="login-totp">Code from your authenticator app</label>
              <input id="login-totp" className="input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={6} value={totp} onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))} autoFocus />
            </div>
          )}
          {err && <p className="error-text" role="alert">{err}</p>}
          <button className="btn btn-primary btn-lg" type="submit" disabled={busy || !pw}>
            {busy ? 'Signing in' : 'Sign in'}
          </button>
          {canPasskey && (
            <button className="btn btn-ghost btn-lg" type="button" onClick={() => void usePasskey()} disabled={busy}>
              <Icon name="shield" size={16} />
              Sign in with fingerprint or face
            </button>
          )}
        </form>
      </div>
    </div>
  );
}
