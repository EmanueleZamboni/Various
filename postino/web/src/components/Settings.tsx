import { type ReactNode, useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useAccounts, useSettings, useUpdateSettings } from '../api/hooks';
import type { Account, AccountInput, Category, Me, SwipeAction } from '../api/types';
import { SignatureEditor } from './SignatureEditor';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { Passkey } from '../api/types';
import { useSignatures, useFolders, useTemplates } from '../api/hooks';
import type { Signature, Template } from '../api/types';
import { Icon, type IconName } from '../icons';
import { useUI } from '../store';
import { currentSubscription, disablePush, enablePush, pushSupported } from '../push';
import { pluralize } from '../util/format';

/** Account colors: four families (postal blue, warm, green, plum) of equal depth, so tags look like one set. */
export const COLOR_FAMILIES: Record<string, string[]> = { blue: ['#2B3D90', '#3F6FB0', '#56657E'], warm: ['#B4593C', '#A3821C', '#8C6A4A'], green: ['#2F7F78', '#5E7F45', '#3E8A6E'], plum: ['#8A4F7D', '#5A4FA0', '#9A5A6B'] };
export const COLORS = ['#2B3D90', '#3F6FB0', '#56657E', '#B4593C', '#A3821C', '#8C6A4A', '#2F7F78', '#5E7F45', '#3E8A6E', '#8A4F7D', '#5A4FA0', '#9A5A6B'];

/** Same domain, same family: info@ and admin@ of one company get shades of one color. */
export function suggestColor(email: string, accounts: { email: string; color: string }[]): string {
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  const used = new Set(accounts.map((a) => a.color.toUpperCase()));
  const sibling = accounts.find((a) => a.email.split('@')[1]?.toLowerCase() === domain);
  const family = sibling ? Object.values(COLOR_FAMILIES).find((f) => f.some((c) => c.toUpperCase() === sibling.color.toUpperCase())) : undefined;
  const pool = family ?? Object.values(COLOR_FAMILIES).find((f) => !f.some((c) => used.has(c.toUpperCase()))) ?? COLORS;
  return pool.find((c) => !used.has(c.toUpperCase())) ?? pool[0];
}

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/settings/accounts', label: 'Accounts', icon: 'people' },
  { to: '/settings/signatures', label: 'Signatures', icon: 'pen' },
  { to: '/settings/templates', label: 'Templates', icon: 'draft' },
  { to: '/settings/inbox', label: 'Inbox', icon: 'inbox' },
  { to: '/settings/reading', label: 'Reading', icon: 'mailOpen' },
  { to: '/settings/composing', label: 'Composing', icon: 'send' },
  { to: '/settings/notifications', label: 'Notifications', icon: 'bell' },
  { to: '/settings/google', label: 'Google Drive', icon: 'folder' },
  { to: '/settings/preferences', label: 'Swipes & look', icon: 'filter' },
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
        <div className="settings-head">
          <Link to="/inbox" className="ib back" aria-label="Back to inbox"><Icon name="back" /></Link>
          <h1>Settings</h1>
        </div>
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
          <Route path="signatures" element={<SignaturesSettings />} />
          <Route path="templates" element={<TemplatesSettings />} />
          <Route path="notifications" element={<NotificationSettings me={me} />} />
          <Route path="google" element={<GoogleSettings />} />
          <Route path="inbox" element={<InboxSettings />} />
          <Route path="reading" element={<ReadingSettings />} />
          <Route path="composing" element={<ComposeSettings />} />
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
  const loc = useLocation();
  const [adding, setAdding] = useState(() => new URLSearchParams(loc.search).get('add') === '1');
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
  const [password, setPassword] = useState('');
  const [aliases, setAliases] = useState((a.aliases ?? []).join(', '));
  const [notify, setNotify] = useState<string>(a.notify ?? 'default');
  const [folderMap, setFolderMap] = useState<Record<string, string>>(a.folders ?? {});
  const { data: folders } = useFolders();
  const myFolders = (folders ?? []).filter((f) => f.accountId === a.id);
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.accounts.update(a.id, {
        name,
        color,
        aliases: aliases.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean),
        notify,
        folders: Object.fromEntries(Object.entries(folderMap).filter(([, v]) => v)),
        ...(password ? { password } : {}),
      }),
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
        <label htmlFor={`al-${a.id}`}>Other addresses delivered to this mailbox (aliases)</label>
        <input id={`al-${a.id}`} className="input" value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="press@example.com, hello@example.com" />
        <small className="help">Replies to mail sent to one of these go out from that address.</small>
      </div>
      <div className="field">
        <label htmlFor={`nt-${a.id}`}>Notifications for this address</label>
        <select id={`nt-${a.id}`} className="select" value={notify} onChange={(e) => setNotify(e.target.value)}>
          <option value="default">Same as the general setting</option>
          <option value="all">Every new email</option>
          <option value="people">Only people</option>
          <option value="none">None</option>
        </select>
      </div>
      <div className="field">
        <span className="label">Folders used for</span>
        <div className="grid-2">
          {(['archive', 'sent', 'drafts', 'junk', 'trash', 'blocked'] as const).map((role) => (
            <label key={role} className="field" style={{ gap: 4 }}>
              <small className="help" style={{ textTransform: 'capitalize' }}>{role === 'junk' ? 'Spam' : role}</small>
              <select className="select" value={folderMap[role] ?? ''} onChange={(e) => setFolderMap((f) => ({ ...f, [role]: e.target.value }))}>
                <option value="">Automatic</option>
                {myFolders.map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
              </select>
            </label>
          ))}
        </div>
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

export function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
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
  const [color, setColor] = useState(() => suggestColor('', accounts ?? []));
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

export function ServerFields({ label, value, onChange, idp }: { label: string; value: { host: string; port: number; secure: boolean }; onChange: (v: { host: string; port: number; secure: boolean }) => void; idp: string }) {
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

function Row({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="toggle-row">
      <div className="t">
        <span>{title}</span>
        {hint && <small>{hint}</small>}
      </div>
      {children}
    </div>
  );
}

function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} />;
}

function Select<T extends string>({ value, onChange, options, label, width = 200 }: { value: T; onChange: (v: T) => void; options: { id: T; label: string }[]; label: string; width?: number }) {
  return (
    <select className="select" style={{ width }} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
    </select>
  );
}

function InboxSettings() {
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  const setSmart = useUI((u) => u.setSmart);
  if (!s) return <h2>Inbox</h2>;
  const inbox = s.inbox;
  const set = (patch: Partial<typeof inbox>) => update.mutate({ inbox: patch });
  return (
    <>
      <h2>Inbox</h2>
      <p className="help">How the list is organised. These apply on every device.</p>
      <div className="settings-section">
        <div className="card">
          <Row title="Smart inbox" hint="People first, with notifications and newsletters grouped"><Switch on={inbox.smart} label="Smart inbox" onChange={(v) => { setSmart(v); set({ smart: v }); }} /></Row>
          <Row title="Group notifications" hint="Receipts, shares, alerts in one card"><Switch on={inbox.groupNotifications} label="Group notifications" onChange={(v) => set({ groupNotifications: v })} /></Row>
          <Row title="Group newsletters" hint="Bulk mail with an unsubscribe link in one card"><Switch on={inbox.groupNewsletters} label="Group newsletters" onChange={(v) => set({ groupNewsletters: v })} /></Row>
          <Row title="Starred on top" hint="Show starred conversations in their own section"><Switch on={inbox.pinnedOnTop} label="Starred on top" onChange={(v) => set({ pinnedOnTop: v })} /></Row>
        </div>
        <div className="card">
          <Row title="Preview lines" hint="Lines of the message shown under the subject"><Select value={String(inbox.previewLines) as '0' | '1' | '2'} label="Preview lines" width={140} options={[{ id: '0', label: 'None' }, { id: '1', label: 'One line' }, { id: '2', label: 'Two lines' }]} onChange={(v) => set({ previewLines: Number(v) as 0 | 1 | 2 })} /></Row>
          <Row title="Sender pictures" hint="Gravatar or company logo, initials otherwise"><Switch on={inbox.showAvatars} label="Sender pictures" onChange={(v) => set({ showAvatars: v })} /></Row>
          <Row title="Show which address" hint="A small tag with the account on each row"><Switch on={inbox.showAccountTag} label="Show account tag" onChange={(v) => set({ showAccountTag: v })} /></Row>
        </div>
      </div>
    </>
  );
}

function ReadingSettings() {
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  if (!s) return <h2>Reading</h2>;
  const r = s.reading;
  const set = (patch: Partial<typeof r>) => update.mutate({ reading: patch });
  return (
    <>
      <h2>Reading</h2>
      <div className="settings-section">
        <div className="card">
          <Row title="Mark as read" hint="When a conversation counts as read"><Select value={r.markRead} label="Mark as read" options={[{ id: 'open', label: 'When opened' }, { id: 'delay', label: 'After a few seconds' }, { id: 'manual', label: 'Only by hand' }]} onChange={(v) => set({ markRead: v })} /></Row>
          {r.markRead === 'delay' && <Row title="Delay" hint="Seconds the conversation stays open before it is marked read"><Select value={String(r.markReadDelay) as '1' | '2' | '5' | '10'} label="Delay" width={120} options={[{ id: '1', label: '1 s' }, { id: '2', label: '2 s' }, { id: '5', label: '5 s' }, { id: '10', label: '10 s' }]} onChange={(v) => set({ markReadDelay: Number(v) })} /></Row>}
          <Row title="After archiving or deleting" hint="What to show next on a computer (the phone always goes back to the list)"><Select value={r.afterAction} label="After an action" options={[{ id: 'next', label: 'Next conversation' }, { id: 'previous', label: 'Previous conversation' }, { id: 'list', label: 'Back to the list' }]} onChange={(v) => set({ afterAction: v })} /></Row>
          <Row title="Ask before deleting"><Switch on={r.confirmDelete} label="Confirm delete" onChange={(v) => set({ confirmDelete: v })} /></Row>
        </div>
        <div className="card">
          <Row title="Images from senders" hint="Remote images can tell a sender you opened the mail"><Select value={r.remoteImages} label="Remote images" width={230} options={[{ id: 'ask', label: 'Ask every time' }, { id: 'contacts', label: 'Load for people I wrote to' }, { id: 'always', label: 'Always load' }]} onChange={(v) => set({ remoteImages: v })} /></Row>
          <Row title="Show quoted text" hint="Expand the earlier messages quoted inside a reply"><Switch on={r.showQuoted} label="Show quoted text" onChange={(v) => set({ showQuoted: v })} /></Row>
        </div>
      </div>
    </>
  );
}

function ComposeSettings() {
  const { data: s } = useSettings();
  const { data: accounts } = useAccounts();
  const update = useUpdateSettings();
  if (!s) return <h2>Composing</h2>;
  const c = s.compose;
  const set = (patch: Partial<typeof c>) => update.mutate({ compose: patch });
  return (
    <>
      <h2>Composing</h2>
      <div className="settings-section">
        <div className="card">
          <Row title="New emails are sent from" hint="Which address a new email starts with"><Select value={c.defaultAccount} label="Default account" width={260} options={[{ id: 'lastUsed', label: 'The last one I used' }, ...(accounts ?? []).map((a) => ({ id: a.id, label: a.email }))]} onChange={(v) => set({ defaultAccount: v })} /></Row>
          <Row title="Reply from the address they wrote to" hint="If a mail came to info@…, the reply goes out from info@…, including aliases you listed on the account"><Switch on={c.replyFromRecipient} label="Reply from recipient address" onChange={(v) => set({ replyFromRecipient: v })} /></Row>
          <Row title="Default reply" hint="What the Reply button does"><Select value={c.defaultReply} label="Default reply" width={160} options={[{ id: 'reply', label: 'Reply' }, { id: 'replyAll', label: 'Reply all' }]} onChange={(v) => set({ defaultReply: v })} /></Row>
          <Row title="Quote the original" hint="Include the message you are answering under your reply"><Switch on={c.includeQuote} label="Include quoted text" onChange={(v) => set({ includeQuote: v })} /></Row>
        </div>
        <div className="card">
          <Row title="Undo send" hint="Hold the email for a moment so you can take it back"><Select value={String(c.undoSendSec) as '0' | '5' | '10' | '20' | '30'} label="Undo send" width={140} options={[{ id: '0', label: 'Off' }, { id: '5', label: '5 seconds' }, { id: '10', label: '10 seconds' }, { id: '20', label: '20 seconds' }, { id: '30', label: '30 seconds' }]} onChange={(v) => set({ undoSendSec: Number(v) as 0 | 5 | 10 | 20 | 30 })} /></Row>
          <Row title="Send a copy to myself (Bcc)"><Switch on={c.bccMyself} label="Bcc myself" onChange={(v) => set({ bccMyself: v })} /></Row>
          <Row title="Warn when the subject is empty"><Switch on={c.confirmNoSubject} label="Warn on empty subject" onChange={(v) => set({ confirmNoSubject: v })} /></Row>
        </div>
      </div>
    </>
  );
}

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
        // Only this device stops; other phones/computers keep their notifications.
        await disablePush();
        setSubscribed(false);
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
      {s && (
        <div className="card" style={{ marginBottom: 12 }}>
          <Row title="Sound" hint="Play a sound with each notification"><Switch on={s.notifications.sound} label="Notification sound" onChange={(v) => update.mutate({ notifications: { sound: v } })} /></Row>
          <Row title="Per address" hint="Set a different level for one address under Accounts → Edit" />
        </div>
      )}
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
  { id: 'pin', label: 'Star' },
  { id: 'trash', label: 'Delete' },
  { id: 'read', label: 'Mark as read' },
  { id: 'junk', label: 'Mark as spam' },
];

function PreferenceSettings() {
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  if (!s) return <h2>Swipes & look</h2>;
  return (
    <>
      <h2>Swipes & look</h2>
      <p className="help">What swiping does on the phone, and how dense the lists are.</p>
      <div className="settings-section">
        <div className="card">
          <Row title="Swipe left" hint="Drag a conversation to the left"><Select value={s.swipe.left} label="Swipe left action" width={170} options={SWIPES} onChange={(v) => update.mutate({ swipe: { left: v } })} /></Row>
          <Row title="Swipe right" hint="Drag a conversation to the right"><Select value={s.swipe.right} label="Swipe right action" width={170} options={SWIPES} onChange={(v) => update.mutate({ swipe: { right: v } })} /></Row>
        </div>
        <div className="card">
          <Row title="Reading" hint="How an email opens on a computer"><Select value={s.appearance.readingPane} label="Reading pane" width={200} options={[{ id: 'full', label: 'Full window (like Gmail)' }, { id: 'side', label: 'Next to the list (like Spark)' }]} onChange={(v) => update.mutate({ appearance: { readingPane: v } })} /></Row>
          <Row title="Density" hint="Space between conversations"><Select value={s.appearance.density} label="Density" width={170} options={[{ id: 'comfortable', label: 'Comfortable' }, { id: 'compact', label: 'Compact' }]} onChange={(v) => update.mutate({ appearance: { density: v } })} /></Row>
          <Row title="Text size"><Select value={s.appearance.textSize} label="Text size" width={170} options={[{ id: 'normal', label: 'Normal' }, { id: 'large', label: 'Large' }]} onChange={(v) => update.mutate({ appearance: { textSize: v } })} /></Row>
        </div>
      </div>
    </>
  );
}

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
        <PasskeysCard />
      </div>
    </>
  );
}

function PasskeysCard() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data } = useQuery({ queryKey: ['passkeys'], queryFn: api.passkeys.list });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState('');
  const [needPw, setNeedPw] = useState(false);
  const supported = typeof window !== 'undefined' && browserSupportsWebAuthn();
  const add = async () => {
    setErr('');
    setBusy(true);
    try {
      let options;
      try {
        options = await api.passkeys.registerOptions(pw || undefined);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'reauth_required') {
          setNeedPw(true);
          if (pw) setErr('Wrong password.');
          return;
        }
        throw e;
      }
      setNeedPw(false);
      setPw('');
      const response = await startRegistration({ optionsJSON: options });
      const name = /Android/i.test(navigator.userAgent) ? 'Android phone' : /iPhone|iPad/i.test(navigator.userAgent) ? 'iPhone' : /Mac/i.test(navigator.userAgent) ? 'Mac' : /Windows/i.test(navigator.userAgent) ? 'Windows PC' : 'This device';
      await api.passkeys.registerVerify(response, name);
      try {
        localStorage.setItem('postino.passkey', '1');
      } catch {
        /* ignore */
      }
      qc.invalidateQueries({ queryKey: ['passkeys'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      toast({ text: 'Fingerprint sign-in added for this device', kind: 'success' });
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError') setErr('Cancelled, or this device already has a passkey here.');
      else if ((e as Error).name === 'InvalidStateError') setErr('This device is already registered.');
      else setErr((e as Error).message || 'Could not add the passkey.');
    } finally {
      setBusy(false);
    }
  };
  const remove = useMutation({
    mutationFn: (id: string) => api.passkeys.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['passkeys'] }); qc.invalidateQueries({ queryKey: ['me'] }); toast({ text: 'Passkey removed' }); },
  });
  const list: Passkey[] = data?.passkeys ?? [];
  return (
    <div className="card">
      <div className="toggle-row" style={{ borderBottom: 0, padding: 0 }}>
        <div className="t">
          <b>Fingerprint / face sign-in</b>
          <small>{supported ? 'Sign in with your fingerprint, face or device PIN instead of the password (a passkey). Add each phone or computer once.' : 'This browser does not support passkeys.'}</small>
        </div>
        {supported && <button className="btn btn-ghost" onClick={() => void add()} disabled={busy}>{busy ? 'Waiting…' : 'Add this device'}</button>}
      </div>
      {needPw && (
        <form className="row-inline" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <input className="input" type="password" autoComplete="current-password" placeholder="Postino password" aria-label="Postino password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
          <button type="submit" className="btn btn-primary" disabled={busy || !pw}>Confirm</button>
        </form>
      )}
      {list.length > 0 && (
        <ul className="plain-list">
          {list.map((p) => (
            <li key={p.id} className="row-inline" style={{ justifyContent: 'space-between' }}>
              <span>
                <b>{p.name}</b>
                <small className="help" style={{ display: 'block' }}>
                  Added {new Date(p.createdAt).toLocaleDateString()}{p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ''}{p.syncedToCloud ? ' · synced by your password manager' : ''}
                </small>
              </span>
              <button className="btn btn-quiet btn-sm" onClick={() => remove.mutate(p.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
      {err && <p className="error-text" role="alert">{err}</p>}
    </div>
  );
}


// ---------- Templates ----------

function TemplatesSettings() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data: templates } = useTemplates();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', subject: '', text: '' });
  const start = (t?: Template) => {
    setEditing(t?.id ?? 'new');
    setForm({ name: t?.name ?? '', subject: t?.subject ?? '', text: t?.text ?? '' });
  };
  const save = useMutation({
    mutationFn: () => (editing && editing !== 'new' ? api.templates.update(editing, form) : api.templates.create(form)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); setEditing(null); toast({ text: 'Template saved', kind: 'success' }); },
    onError: (e) => toast({ text: (e as Error).message, kind: 'error' }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.templates.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['templates'] }); toast({ text: 'Template deleted' }); },
  });
  return (
    <div className="settings-section">
      <h2>Templates</h2>
      <p className="help">Ready-made emails for things you write often. Insert one with the template button while writing. <code>{'{nome}'}</code> becomes the recipient's first name.</p>
      {(templates ?? []).map((t) =>
        editing === t.id ? null : (
          <div className="card tpl-card" key={t.id}>
            <div className="row-inline" style={{ justifyContent: 'space-between' }}>
              <div><b>{t.name}</b>{t.subject && <small className="help"> · {t.subject}</small>}</div>
              <div className="row-inline">
                <button className="btn btn-ghost btn-sm" onClick={() => start(t)}>Edit</button>
                <button className="ib" aria-label={`Delete ${t.name}`} onClick={() => { if (window.confirm(`Delete the template "${t.name}"?`)) remove.mutate(t.id); }}><Icon name="trash" size={16} /></button>
              </div>
            </div>
            <p className="tpl-preview">{t.text}</p>
          </div>
        ),
      )}
      {editing ? (
        <form className="card" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div className="field"><label htmlFor="tpl-name">Name</label><input id="tpl-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Preventivo" autoFocus /></div>
          <div className="field"><label htmlFor="tpl-subject">Subject (optional)</label><input id="tpl-subject" className="input" value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></div>
          <div className="field"><label htmlFor="tpl-text">Text</label><textarea id="tpl-text" className="input" rows={8} value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder={'Ciao {nome},\n\n…'} /></div>
          <div className="row-inline">
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!form.name.trim() || save.isPending}>Save template</button>
          </div>
        </form>
      ) : (
        <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => start()}><Icon name="plus" size={15} />New template</button>
      )}
    </div>
  );
}

// ---------- Signatures ----------

function SignaturesSettings() {
  const { data: accounts } = useAccounts();
  const { data: signatures, isLoading } = useSignatures();
  const [editing, setEditing] = useState<Signature | 'new' | null>(null);
  const [newFor, setNewFor] = useState<string>('');
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const remove = useMutation({
    mutationFn: (id: string) => api.signatures.remove(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['signatures'] }); toast({ text: 'Signature removed' }); },
  });
  const makeDefault = useMutation({
    mutationFn: (id: string) => api.signatures.update(id, { isDefault: true }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['signatures'] }); toast({ text: 'Default signature set' }); },
  });
  return (
    <>
      <h2>Signatures</h2>
      <p className="help">Each account can have several signatures with formatting and images. The default one is added to new emails and replies; you can switch or remove it while writing.</p>
      {(accounts ?? []).map((a) => {
        const mine = (signatures ?? []).filter((s) => s.accountId === a.id);
        return (
          <div className="settings-section" key={a.id}>
            <div className="row-inline" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <span className="row-inline" style={{ gap: 8 }}><i className="dot" style={{ ['--c' as string]: a.color }} /><b>{a.email}</b></span>
              <button className="btn btn-ghost btn-sm" onClick={() => { setNewFor(a.id); setEditing('new'); }}><Icon name="plus" size={14} />Add signature</button>
            </div>
            {editing === 'new' && newFor === a.id && (
              <SignatureForm accountId={a.id} onDone={() => setEditing(null)} />
            )}
            {!isLoading && mine.length === 0 && editing !== 'new' && <p className="help">No signature yet for this address.</p>}
            {mine.map((s) =>
              editing !== 'new' && editing?.id === s.id ? (
                <SignatureForm key={s.id} accountId={a.id} signature={s} onDone={() => setEditing(null)} />
              ) : (
                <div className="sig-card" key={s.id}>
                  <div className="row-inline" style={{ justifyContent: 'space-between' }}>
                    <span className="row-inline" style={{ gap: 8 }}><b>{s.name}</b>{s.isDefault && <span className="sig-default">Default</span>}</span>
                    <span className="row-inline" style={{ gap: 4 }}>
                      {!s.isDefault && <button className="btn btn-quiet btn-sm" onClick={() => makeDefault.mutate(s.id)}>Make default</button>}
                      <button className="btn btn-quiet btn-sm" onClick={() => setEditing(s)}>Edit</button>
                      <button className="ib danger" aria-label={`Remove ${s.name}`} title="Remove" onClick={() => remove.mutate(s.id)}><Icon name="trash" size={16} /></button>
                    </span>
                  </div>
                  <div className="sig-render" dangerouslySetInnerHTML={{ __html: s.html }} />
                </div>
              ),
            )}
          </div>
        );
      })}
    </>
  );
}

function SignatureForm({ accountId, signature, onDone }: { accountId: string; signature?: Signature; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const [name, setName] = useState(signature?.name ?? 'Signature');
  const [html, setHtml] = useState(signature?.html ?? '');
  const [isDefault, setIsDefault] = useState(signature?.isDefault ?? false);
  const [err, setErr] = useState('');
  const save = useMutation({
    mutationFn: () => (signature ? api.signatures.update(signature.id, { name, html, isDefault }) : api.signatures.create({ accountId, name, html, isDefault })),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['signatures'] }); toast({ text: signature ? 'Signature saved' : 'Signature added' }); onDone(); },
    onError: (e) => setErr((e as Error).message),
  });
  return (
    <form className="card" style={{ margin: '8px 0' }} onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
      <div className="field">
        <label htmlFor={`sig-name-${signature?.id ?? 'new'}`}>Name</label>
        <input id={`sig-name-${signature?.id ?? 'new'}`} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, Short, Italian…" />
      </div>
      <div className="field">
        <span className="label">Signature</span>
        <SignatureEditor value={html} onChange={setHtml} />
      </div>
      <label className="row-inline" style={{ gap: 8 }}>
        <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        Use as the default for this address
      </label>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="row-inline">
        <button type="submit" className="btn btn-primary" disabled={save.isPending}>{save.isPending ? 'Saving' : signature ? 'Save changes' : 'Add signature'}</button>
        <button type="button" className="btn btn-quiet" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}


// ---------- Google Drive ----------

function GoogleSettings() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const loc = useLocation();
  const { data } = useQuery({ queryKey: ['google'], queryFn: api.google.status, retry: false });
  const { data: redirect } = useQuery({ queryKey: ['google-redirect'], queryFn: api.google.redirectUri });
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState('');
  const result = new URLSearchParams(loc.search).get('result');
  useEffect(() => {
    if (!result) return;
    qc.invalidateQueries({ queryKey: ['google'] });
    toast({ text: result === 'connected' ? 'Google Drive connected' : result, kind: result === 'connected' ? 'success' : 'error' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  const saveCreds = useMutation({
    mutationFn: () => api.google.credentials(clientId || data?.clientId || '', secret),
    onSuccess: () => { setSecret(''); qc.invalidateQueries({ queryKey: ['google'] }); toast({ text: 'Saved. Now connect your Google account.', kind: 'success' }); },
    onError: (e) => setErr((e as Error).message),
  });
  const connect = async () => {
    try {
      const r = await api.google.connect();
      window.location.href = r.url;
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const disconnect = useMutation({ mutationFn: () => api.google.disconnect(), onSuccess: () => { qc.invalidateQueries({ queryKey: ['google'] }); toast({ text: 'Google Drive disconnected' }); } });
  return (
    <>
      <h2>Google Drive</h2>
      <p className="help">Save attachments to Drive and open Word, Excel and PowerPoint files straight in Google Docs, Sheets and Slides, like Gmail does. Postino only ever sees the files it uploads (the "drive.file" permission).</p>
      <div className="settings-section">
        {data?.connected ? (
          <div className="card">
            <div className="toggle-row" style={{ borderBottom: 0, padding: 0 }}>
              <div className="t">
                <b>Connected{data.email ? ` as ${data.email}` : ''}</b>
                <small>Attachments now show "Save to Drive" and "Open in Google Docs/Sheets/Slides".</small>
              </div>
              <button className="btn btn-ghost" onClick={() => disconnect.mutate()} disabled={disconnect.isPending}>Disconnect</button>
            </div>
          </div>
        ) : data?.managed ? (
          <div className="card">
            <b>Connect your Google account</b>
            <p className="help" style={{ margin: 0 }}>Opens Google's sign-in. Postino only gets access to the files it saves, never to the rest of your Drive.</p>
            <div className="row-inline">
              <button type="button" className="btn btn-primary" onClick={() => void connect()}>Connect Google Drive</button>
            </div>
          </div>
        ) : (
          <>
            <div className="card">
              <b>1. Create a Google OAuth client (once, about 5 minutes)</b>
              <ol className="help" style={{ margin: '6px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                <li>Open <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">console.cloud.google.com/apis/credentials</a> (any project; the one from your YouTube scripts is fine).</li>
                <li>Enable the <b>Google Drive API</b> under "APIs & Services → Library".</li>
                <li>"Create credentials → OAuth client ID", type <b>Web application</b>.</li>
                <li>Under "Authorized redirect URIs" add exactly: <code style={{ userSelect: 'all' }}>{redirect?.redirectUri ?? '…'}</code></li>
                <li>If the consent screen asks, add your own Google address as a test user.</li>
                <li>Copy the client ID and client secret below.</li>
              </ol>
            </div>
            <form className="card" onSubmit={(e) => { e.preventDefault(); setErr(''); saveCreds.mutate(); }}>
              <b>2. Paste the client</b>
              <div className="field"><label htmlFor="g-id">Client ID</label><input id="g-id" className="input" value={clientId || data?.clientId || ''} onChange={(e) => setClientId(e.target.value)} placeholder="1234-abcd.apps.googleusercontent.com" autoComplete="off" /></div>
              <div className="field"><label htmlFor="g-secret">Client secret</label><input id="g-secret" className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={data?.configured ? '(saved)' : 'GOCSPX-…'} autoComplete="off" /></div>
              {err && <p className="error-text" role="alert">{err}</p>}
              <div className="row-inline">
                <button type="submit" className="btn btn-ghost" disabled={saveCreds.isPending || !secret}>Save</button>
                <button type="button" className="btn btn-primary" onClick={() => void connect()} disabled={!data?.configured}>3. Connect Google account</button>
              </div>
            </form>
          </>
        )}
      </div>
    </>
  );
}
