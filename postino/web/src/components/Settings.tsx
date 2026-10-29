import { useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useAccounts, useSettings, useUpdateSettings } from '../api/hooks';
import type { Account, AccountInput, Category, Me, SwipeAction } from '../api/types';
import { Icon, type IconName } from '../icons';
import { useUI } from '../store';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push';
import { pluralize } from '../util/format';

const COLORS = ['#3B6FE0', '#D9486B', '#2E9E6B', '#8A5BD6', '#E07C2A', '#1AA3B5', '#9A8A1E', '#5B6B9E', '#B8456B', '#157A5B'];

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/settings/accounts', label: 'Accounts', icon: 'people' },
  { to: '/settings/notifications', label: 'Notifications', icon: 'bell' },
  { to: '/settings/preferences', label: 'Preferences', icon: 'filter' },
  { to: '/settings/security', label: 'Security', icon: 'shield' },
];

export function SettingsPage({ me, onLogout }: { me?: Me; onLogout: () => void }) {
  const loc = useLocation();
  const toast = useUI((s) => s.toast);
  const logout = async () => {
    await api.auth.logout().catch(() => undefined);
    onLogout();
    toast({ text: 'Signed out' });
  };
  return (
    <section className="settings" aria-label="Settings">
      <nav className="settings-nav">
        <h1>Settings</h1>
        {NAV.map((n) => {
          const on = loc.pathname === n.to || (loc.pathname === '/settings' && n.to === '/settings/accounts');
          return (
            <Link key={n.to} to={n.to} className={`nav-item${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}>
              <Icon name={n.icon} size={18} />
              <span>{n.label}</span>
            </Link>
          );
        })}
        <button className="nav-item" onClick={() => void logout()} style={{ marginTop: 'auto' }}>
          <Icon name="logout" size={18} />
          <span>Sign out</span>
        </button>
      </nav>
      <div className="settings-main">
        <Routes>
          <Route index element={<AccountsSettings />} />
          <Route path="accounts" element={<AccountsSettings />} />
          <Route path="notifications" element={<NotificationSettings me={me} />} />
          <Route path="preferences" element={<PreferenceSettings />} />
          <Route path="security" element={<SecuritySettings me={me} />} />
        </Routes>
      </div>
    </section>
  );
}

// ---------- Accounts ----------

function AccountsSettings() {
  const { data: accounts, isLoading } = useAccounts();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <>
      <h2>Accounts</h2>
      <p className="help">Every mailbox you add shows up in the unified inbox. Passwords are stored encrypted on your server and never leave it.</p>
      <div className="settings-section">
        <div className="card" style={{ gap: 0 }}>
          {isLoading && <div className="help">Loading</div>}
          {(accounts ?? []).map((a) =>
            editing === a.id ? (
              <EditAccount key={a.id} account={a} onDone={() => setEditing(null)} />
            ) : (
              <AccountRow key={a.id} account={a} onEdit={() => setEditing(a.id)} />
            ),
          )}
          {!isLoading && !accounts?.length && <div className="help">No accounts yet. Add your first mailbox below.</div>}
        </div>
        {adding ? (
          <AddAccount onDone={() => setAdding(false)} />
        ) : (
          <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} />
            Add account
          </button>
        )}
      </div>
    </>
  );
}

function AccountRow({ account: a, onEdit }: { account: Account; onEdit: () => void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const resync = useMutation({ mutationFn: () => api.accounts.resync(a.id), onSuccess: () => { toast({ text: `Re-syncing ${a.email}` }); qc.invalidateQueries({ queryKey: ['accounts'] }); } });
  const remove = useMutation({ mutationFn: () => api.accounts.remove(a.id), onSuccess: () => { toast({ text: `Removed ${a.email}` }); qc.invalidateQueries({ queryKey: ['accounts'] }); qc.invalidateQueries({ queryKey: ['threads'] }); qc.invalidateQueries({ queryKey: ['folders'] }); } });
  const [confirm, setConfirm] = useState(false);
  const pill = a.status === 'error' ? <span className="status-pill err">Needs attention</span> : a.status === 'syncing' ? <span className="status-pill sync">Syncing</span> : a.status === 'connected' ? <span className="status-pill ok">Connected</span> : <span className="status-pill">{a.status}</span>;
  const sync = a.initialSync;
  return (
    <div className="acct-row">
      <i className="dot" style={{ ['--c' as string]: a.color, width: 12, height: 12 }} />
      <div className="acct">
        <span style={{ fontWeight: 500 }}>{a.email}</span>
        <small>{a.name}{a.error ? ` · ${a.error}` : ''}</small>
        {sync && !sync.done && (
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <small>Downloading mail: {sync.fetched} of {sync.total}</small>
            <div className="progress"><i style={{ width: `${sync.total ? Math.round((sync.fetched / sync.total) * 100) : 0}%` }} /></div>
          </div>
        )}
      </div>
      {pill}
      <button className="ib" aria-label="Re-sync" title="Re-sync all mail" onClick={() => resync.mutate()} disabled={resync.isPending}><Icon name="refresh" size={18} /></button>
      <button className="ib" aria-label="Edit account" title="Edit" onClick={onEdit}><Icon name="pen" size={18} /></button>
      {confirm ? (
        <span className="row-inline" style={{ gap: 4 }}>
          <button className="btn btn-danger btn-sm" onClick={() => remove.mutate()} disabled={remove.isPending}>Remove</button>
          <button className="btn btn-quiet btn-sm" onClick={() => setConfirm(false)}>Keep</button>
        </span>
      ) : (
        <button className="ib danger" aria-label="Remove account" title="Remove from Postino" onClick={() => setConfirm(true)}><Icon name="trash" size={18} /></button>
      )}
    </div>
  );
}

function EditAccount({ account: a, onDone }: { account: Account; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const [name, setName] = useState(a.name);
  const [color, setColor] = useState(a.color);
  const [signature, setSignature] = useState(a.signature);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => api.accounts.update(a.id, { name, color, signature, ...(password ? { password } : {}) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); toast({ text: 'Account updated' }); onDone(); },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <form className="card" style={{ margin: '8px 0' }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="row-inline" style={{ justifyContent: 'space-between' }}>
        <b>{a.email}</b>
        <button type="button" className="ib" aria-label="Cancel" onClick={onDone}><Icon name="x" size={16} /></button>
      </div>
      <div className="field">
        <label htmlFor={`n-${a.id}`}>Name shown to recipients</label>
        <input id={`n-${a.id}`} className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <span className="label">Color</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      <div className="field">
        <label htmlFor={`s-${a.id}`}>Signature</label>
        <textarea id={`s-${a.id}`} className="textarea" value={signature} onChange={(e) => setSignature(e.target.value)} placeholder="Added at the end of new emails from this account" />
      </div>
      <div className="field">
        <label htmlFor={`p-${a.id}`}>New password {a.status === 'error' ? '(the server rejected the current one)' : '(leave empty to keep)'}</label>
        <input id={`p-${a.id}`} className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="row-inline">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving' : 'Save changes'}</button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  return (
    <div className="colors" role="radiogroup" aria-label="Account color">
      {COLORS.map((c) => (
        <button key={c} type="button" className={`color-swatch${value === c ? ' on' : ''}`} style={{ ['--c' as string]: c }} role="radio" aria-checked={value === c} aria-label={c} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

function AddAccount({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data: accounts } = useAccounts();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [imap, setImap] = useState({ host: '', port: 993, secure: true });
  const [smtp, setSmtp] = useState({ host: '', port: 465, secure: true });
  const [color, setColor] = useState(COLORS[(accounts?.length ?? 0) % COLORS.length]);
  const [advanced, setAdvanced] = useState(false);
  const [presetNote, setPresetNote] = useState('');
  const [err, setErr] = useState('');
  const [tested, setTested] = useState(false);

  const lookup = async () => {
    if (!email.includes('@')) return;
    try {
      const p = await api.accounts.presets(email);
      if (p) {
        setImap(p.imap);
        setSmtp(p.smtp);
        setUsername(p.username);
        setPresetNote(`Server settings found for ${email.split('@')[1]}.`);
      } else {
        setPresetNote('No known settings for this domain. Fill in the servers below.');
        setAdvanced(true);
      }
    } catch {
      setAdvanced(true);
    }
  };

  const input = (): AccountInput => ({ email: email.trim(), name: name.trim() || email.trim(), password, imap, smtp, username: username.trim() || undefined, color });
  const test = useMutation({
    mutationFn: () => api.accounts.test(input()),
    onSuccess: () => { setTested(true); setErr(''); toast({ text: 'Connection works', kind: 'success' }); },
    onError: (e) => { setTested(false); setErr(describe(e)); setAdvanced(true); },
  });
  const create = useMutation({
    mutationFn: () => api.accounts.create(input()),
    onSuccess: (a) => { qc.invalidateQueries({ queryKey: ['accounts'] }); qc.invalidateQueries({ queryKey: ['folders'] }); toast({ text: `Added ${a.email}. Downloading mail in the background.` }); onDone(); },
    onError: (e) => { setErr(describe(e)); setAdvanced(true); },
  });
  const describe = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'imap_login_failed') return `Incoming mail server refused the login. ${e.message}`;
      if (e.code === 'smtp_login_failed') return `Outgoing mail server refused the login. ${e.message}`;
      return e.message;
    }
    return 'Could not reach the server.';
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!email.includes('@') || !password) return setErr('Email and password are required.');
    if (!imap.host || !smtp.host) return setErr('Server addresses are missing. Open Advanced and fill them in.');
    create.mutate();
  };

  return (
    <form className="card" onSubmit={submit}>
      <div className="row-inline" style={{ justifyContent: 'space-between' }}>
        <b>Add a mailbox</b>
        <button type="button" className="ib" aria-label="Cancel" onClick={onDone}><Icon name="x" size={16} /></button>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="add-email">Email address</label>
          <input id="add-email" className="input" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => void lookup()} placeholder="you@yourdomain.it" />
        </div>
        <div className="field">
          <label htmlFor="add-name">Name shown to recipients</label>
          <input id="add-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Emanuele Zamboni" />
        </div>
      </div>
      <div className="field">
        <label htmlFor="add-pw">Mailbox password</label>
        <input id="add-pw" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <span className="help">For Gmail or iCloud use an app password, not your normal one.</span>
      </div>
      {presetNote && <p className="help">{presetNote}</p>}
      <button type="button" className="btn btn-quiet btn-sm" style={{ alignSelf: 'flex-start' }} onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
        <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} />
        Server settings
      </button>
      {advanced && (
        <>
          <div className="field">
            <label htmlFor="add-user">Username (usually the full address)</label>
            <input id="add-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={email} />
          </div>
          <ServerFields label="Incoming (IMAP)" value={imap} onChange={setImap} idp="imap" />
          <ServerFields label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} idp="smtp" />
        </>
      )}
      <div className="field">
        <span className="label">Color</span>
        <ColorPicker value={color} onChange={setColor} />
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="row-inline">
        <button type="button" className="btn btn-ghost" onClick={() => test.mutate()} disabled={test.isPending || !email || !password}>
          {test.isPending ? 'Testing' : tested ? 'Works' : 'Test connection'}
        </button>
        <button type="submit" className="btn btn-primary" disabled={create.isPending}>{create.isPending ? 'Adding' : 'Add account'}</button>
      </div>
    </form>
  );
}

function ServerFields({ label, value, onChange, idp }: { label: string; value: { host: string; port: number; secure: boolean }; onChange: (v: { host: string; port: number; secure: boolean }) => void; idp: string }) {
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="row-inline" style={{ flexWrap: 'nowrap' }}>
        <input className="input" aria-label={`${label} host`} id={`${idp}-host`} value={value.host} onChange={(e) => onChange({ ...value, host: e.target.value })} placeholder="mail.example.com" />
        <input className="input" aria-label={`${label} port`} id={`${idp}-port`} type="number" style={{ width: 90, flex: 'none' }} value={value.port} onChange={(e) => onChange({ ...value, port: Number(e.target.value) })} />
        <label className="row-inline" style={{ flex: 'none', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={value.secure} onChange={(e) => onChange({ ...value, secure: e.target.checked })} />
          TLS
        </label>
      </div>
    </div>
  );
}

// ---------- Notifications ----------

function NotificationSettings({ me }: { me?: Me }) {
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  const toast = useUI((s) => s.toast);
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void currentSubscription().then((sub) => setSubscribed(!!sub));
  }, []);
  const supported = pushSupported();
  const toggle = async () => {
    if (!me) return;
    setBusy(true);
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
        await update.mutateAsync({ notifications: { enabled: false, categories: s?.notifications.categories ?? ['person'] } });
      } else {
        const r = await enablePush(me.vapidPublicKey);
        if (r === 'denied') toast({ text: 'Notifications are blocked for this site in your browser settings.', kind: 'error' });
        else if (r === 'unsupported') toast({ text: 'This browser cannot show push notifications. On iPhone, add Postino to the Home Screen first.', kind: 'error' });
        else {
          setSubscribed(true);
          await update.mutateAsync({ notifications: { enabled: true, categories: s?.notifications.categories ?? ['person'] } });
          toast({ text: 'Notifications on for this device', kind: 'success' });
        }
      }
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const cats: { id: Category; label: string; hint: string }[] = [
    { id: 'person', label: 'People', hint: 'Mail written by a person to you' },
    { id: 'notification', label: 'Notifications', hint: 'Receipts, shares, alerts from services' },
    { id: 'newsletter', label: 'Newsletters and pitches', hint: 'Bulk mail and sponsorship offers' },
  ];
  const setCat = (id: Category, on: boolean) => {
    const cur = new Set(s?.notifications.categories ?? []);
    if (on) cur.add(id);
    else cur.delete(id);
    update.mutate({ notifications: { enabled: s?.notifications.enabled ?? false, categories: [...cur] } });
  };
  return (
    <>
      <h2>Notifications</h2>
      <p className="help">Push notifications are sent by your server the moment mail arrives, so they work even when Postino is closed.</p>
      <div className="settings-section">
        <div className="card">
          <div className="toggle-row">
            <div className="t">
              <span>Notify on this device</span>
              <small>{supported ? (subscribed ? 'On for this browser' : 'Off') : 'Not supported in this browser. On Android, use Chrome; on iPhone, add Postino to the Home Screen.'}</small>
            </div>
            <button className="switch" role="switch" aria-checked={!!subscribed} aria-label="Notify on this device" onClick={() => void toggle()} disabled={busy || !supported || !me} />
          </div>
          {cats.map((c) => (
            <div className="toggle-row" key={c.id}>
              <div className="t">
                <span>{c.label}</span>
                <small>{c.hint}</small>
              </div>
              <button className="switch" role="switch" aria-checked={s?.notifications.categories.includes(c.id) ?? false} aria-label={c.label} onClick={() => setCat(c.id, !s?.notifications.categories.includes(c.id))} disabled={!s} />
            </div>
          ))}
        </div>
        <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} disabled={!subscribed} onClick={() => api.push.test().then(() => toast({ text: 'Test notification sent' })).catch((e) => toast({ text: (e as Error).message, kind: 'error' }))}>
          Send a test notification
        </button>
      </div>
    </>
  );
}

// ---------- Preferences ----------

const SWIPES: { id: SwipeAction; label: string }[] = [
  { id: 'archive', label: 'Archive' },
  { id: 'pin', label: 'Pin' },
  { id: 'trash', label: 'Delete' },
  { id: 'read', label: 'Mark as read' },
  { id: 'junk', label: 'Mark as spam' },
];

function PreferenceSettings() {
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  const smart = useUI((u) => u.smart);
  const setSmart = useUI((u) => u.setSmart);
  return (
    <>
      <h2>Preferences</h2>
      <p className="help">How the inbox is laid out and what swiping does on the phone.</p>
      <div className="settings-section">
        <div className="card">
          <div className="toggle-row">
            <div className="t">
              <span>Smart inbox</span>
              <small>People first; notifications and newsletters grouped below</small>
            </div>
            <button className="switch" role="switch" aria-checked={smart} aria-label="Smart inbox" onClick={() => { setSmart(!smart); update.mutate({ smartInbox: !smart }); }} />
          </div>
          <div className="toggle-row">
            <div className="t">
              <span>Swipe left</span>
              <small>Drag a conversation to the left</small>
            </div>
            <select className="select" style={{ width: 170 }} aria-label="Swipe left action" value={s?.swipe.left ?? 'archive'} onChange={(e) => update.mutate({ swipe: { left: e.target.value as SwipeAction, right: s?.swipe.right ?? 'pin' } })}>
              {SWIPES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
          <div className="toggle-row">
            <div className="t">
              <span>Swipe right</span>
              <small>Drag a conversation to the right</small>
            </div>
            <select className="select" style={{ width: 170 }} aria-label="Swipe right action" value={s?.swipe.right ?? 'pin'} onChange={(e) => update.mutate({ swipe: { left: s?.swipe.left ?? 'archive', right: e.target.value as SwipeAction } })}>
              {SWIPES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------- Security ----------

function SecuritySettings({ me }: { me?: Me }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [next2, setNext2] = useState('');
  const [err, setErr] = useState('');
  const change = useMutation({
    mutationFn: () => api.auth.changePassword(cur, next),
    onSuccess: () => { toast({ text: 'Password changed', kind: 'success' }); setCur(''); setNext(''); setNext2(''); setErr(''); },
    onError: (e) => setErr((e as Error).message),
  });
  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [terr, setTerr] = useState('');
  const start = useMutation({ mutationFn: () => api.auth.totpStart(), onSuccess: setTotp, onError: (e) => setTerr((e as Error).message) });
  const enable = useMutation({ mutationFn: () => api.auth.totpEnable(code), onSuccess: () => { setTotp(null); setCode(''); qc.invalidateQueries({ queryKey: ['me'] }); toast({ text: 'Two-step verification is on', kind: 'success' }); }, onError: (e) => setTerr((e as Error).message) });
  const disable = useMutation({ mutationFn: () => api.auth.totpDisable(pw), onSuccess: () => { setPw(''); qc.invalidateQueries({ queryKey: ['me'] }); toast({ text: 'Two-step verification is off' }); }, onError: (e) => setTerr((e as Error).message) });

  return (
    <>
      <h2>Security</h2>
      <p className="help">One password protects {pluralize(7, 'mailbox', 'mailboxes').replace('7 ', 'all your ')}. Add two-step verification for a second lock.</p>
      <div className="settings-section">
        <form className="card" onSubmit={(e) => { e.preventDefault(); if (next.length < 10) return setErr('Use at least 10 characters.'); if (next !== next2) return setErr('The new passwords do not match.'); change.mutate(); }}>
          <b>Change password</b>
          <div className="field"><label htmlFor="sec-cur">Current password</label><input id="sec-cur" className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></div>
          <div className="grid-2">
            <div className="field"><label htmlFor="sec-next">New password</label><input id="sec-next" className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></div>
            <div className="field"><label htmlFor="sec-next2">Repeat it</label><input id="sec-next2" className="input" type="password" autoComplete="new-password" value={next2} onChange={(e) => setNext2(e.target.value)} /></div>
          </div>
          {err && <p className="error-text" role="alert">{err}</p>}
          <button type="submit" className="btn btn-primary" style={{ alignSelf: 'flex-start' }} disabled={change.isPending || !cur || !next}>Change password</button>
        </form>
        <div className="card">
          <div className="toggle-row" style={{ borderBottom: 0, padding: 0 }}>
            <div className="t">
              <b>Two-step verification</b>
              <small>{me?.totpEnabled ? 'On. You need a code from your authenticator app to sign in.' : 'Off. Turn it on to require a code from an authenticator app.'}</small>
            </div>
            {!me?.totpEnabled && !totp && <button className="btn btn-ghost" onClick={() => start.mutate()} disabled={start.isPending}>Turn on</button>}
          </div>
          {totp && (
            <div className="field" style={{ gap: 12 }}>
              <p className="help">Scan this with Google Authenticator, Aegis or 1Password, then enter the 6-digit code it shows.</p>
              <img src={totp.qrDataUrl} alt="QR code for your authenticator app" width={160} height={160} style={{ borderRadius: 8, border: '1px solid var(--line)' }} />
              <small className="help">Can’t scan? Key: <code style={{ userSelect: 'all' }}>{totp.secret}</code></small>
              <div className="row-inline">
                <input className="input" style={{ width: 140 }} inputMode="numeric" maxLength={6} placeholder="123456" aria-label="Verification code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                <button className="btn btn-primary" onClick={() => enable.mutate()} disabled={code.length !== 6 || enable.isPending}>Verify and turn on</button>
                <button className="btn btn-quiet" onClick={() => setTotp(null)}>Cancel</button>
              </div>
            </div>
          )}
          {me?.totpEnabled && (
            <div className="row-inline">
              <input className="input" style={{ width: 220 }} type="password" placeholder="Your password" aria-label="Password to turn off" value={pw} onChange={(e) => setPw(e.target.value)} />
              <button className="btn btn-ghost" onClick={() => disable.mutate()} disabled={!pw || disable.isPending}>Turn off</button>
            </div>
          )}
          {terr && <p className="error-text" role="alert">{terr}</p>}
        </div>
      </div>
    </>
  );
}
