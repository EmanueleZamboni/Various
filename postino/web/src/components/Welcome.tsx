import { Link } from 'react-router-dom';
import { GoogleSignInButton, useGoogleReady, useGoogleResult } from './GoogleSignIn';
import { PendingMailboxes, RestoreButton } from './Backup';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, ApiError } from '../api/client';
import { useAccounts, useMe, useSettings, useUpdateSettings } from '../api/hooks';
import type { Account, AccountInput } from '../api/types';
import { Icon, type IconName } from '../icons';
import { useUI } from '../store';
import { ColorPicker, ServerFields, suggestColor } from './Settings';
import { useAccounts as useAccountsList } from '../api/hooks';
import { canPromptInstall, isInstalled, onInstallChange, platform, promptInstall } from '../install';
import { enablePush, pushSupported, currentSubscription } from '../push';

/**
 * First-run wizard: the four things a new person needs, in order, with nothing
 * else on screen. Mailboxes are required; the rest can be skipped and done later
 * from Settings.
 */
const STEPS: { id: Step; label: string; icon: IconName }[] = [
  { id: 'mail', label: 'Mailboxes', icon: 'mail' },
  { id: 'phone', label: 'Phone', icon: 'phone' },
  { id: 'notify', label: 'Alerts', icon: 'bell' },
  { id: 'passkey', label: 'Fingerprint', icon: 'fingerprint' },
  { id: 'done', label: 'Ready', icon: 'sparkle' },
];
type Step = 'mail' | 'phone' | 'notify' | 'passkey' | 'done';

const WIZARD_KEY = 'postino.wizard';
export const markWizardOpen = () => {
  try {
    localStorage.setItem(WIZARD_KEY, '1');
  } catch {
    /* ignore */
  }
};
export const wizardWanted = () => {
  try {
    return localStorage.getItem(WIZARD_KEY) === '1';
  } catch {
    return false;
  }
};
const markWizardDone = () => {
  try {
    localStorage.removeItem(WIZARD_KEY);
  } catch {
    /* ignore */
  }
};

export function Welcome({ onFinish }: { onFinish: () => void }) {
  const { data: accounts } = useAccounts();
  const [step, setStep] = useState<Step>('mail');
  const idx = STEPS.findIndex((s) => s.id === step);
  const next = () => setStep(STEPS[Math.min(idx + 1, STEPS.length - 1)].id);
  const finish = () => {
    markWizardDone();
    onFinish();
  };
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);

  return (
    <div className="auth wizard-page">
      <div className="auth-card wizard">
        <div className="brand">
          <span className="brand-mark"><img src={`${import.meta.env.BASE_URL}icon.svg`} alt="" width={36} height={36} /></span>
        <span className="brand-name">Postino</span>
          <span className="wizard-count">{Math.min(idx + 1, STEPS.length - 1)} of {STEPS.length - 1}</span>
          <Link to="/settings" className="btn btn-quiet btn-sm wizard-close" title="Settings">
            <Icon name="settings" size={16} />
            Settings
          </Link>
          {(accounts?.length ?? 0) > 0 && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={onFinish}>
              <Icon name="x" size={16} />
              Close
            </button>
          )}
        </div>
        <ol className="wizard-steps" aria-label="Setup steps">
          {STEPS.slice(0, -1).map((s, i) => (
            <li key={s.id} className={i < idx ? 'done' : i === idx ? 'now' : ''} aria-current={i === idx ? 'step' : undefined}>
              <span className="ws-dot">{i < idx ? <Icon name="check" size={12} /> : <Icon name={s.icon} size={13} />}</span>
              <span className="ws-label">{s.label}</span>
            </li>
          ))}
        </ol>
        {step === 'mail' && <MailStep accounts={accounts ?? []} onNext={next} />}
        {step === 'phone' && <PhoneStep onNext={next} />}
        {step === 'notify' && <NotifyStep onNext={next} />}
        {step === 'passkey' && <PasskeyStep onNext={next} />}
        {step === 'done' && <DoneStep accounts={accounts ?? []} onFinish={finish} />}
      </div>
    </div>
  );
}

function StepHeader({ title, text }: { title: string; text: ReactNode }) {
  return (
    <div className="wizard-head">
      <h1>{title}</h1>
      <p className="help">{text}</p>
    </div>
  );
}

// ---------- 1. Mailboxes ----------

type Provider = { name: string; hint: ReactNode };
function providerFor(email: string): Provider | null {
  const d = email.split('@')[1]?.toLowerCase() || '';
  if (/^(gmail|googlemail)\.com$/.test(d))
    return {
      name: 'Gmail',
      hint: (
        <>
          <b>Gmail in 3 steps:</b> 1. open{' '}
          <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">Google app passwords</a>{' '}
          (two-step verification must be on) · 2. create one named “Postino” · 3. paste the 16 letters below as the password.
        </>
      ),
    };
  if (/^(icloud|me|mac)\.com$/.test(d))
    return { name: 'iCloud', hint: <>iCloud needs an <b>app-specific password</b> from <a href="https://appleid.apple.com" target="_blank" rel="noopener">appleid.apple.com</a> → Sign-In and Security.</> };
  if (/^(outlook|hotmail|live)\.(com|it)$/.test(d))
    return { name: 'Outlook', hint: <>Microsoft accounts often refuse password sign-in for mail apps. If the test fails, this address may not be usable here.</> };
  if (/^(yahoo)\.(com|it)$/.test(d)) return { name: 'Yahoo', hint: <>Yahoo needs an <b>app password</b> from Account security → Generate app password.</> };
  return null;
}

function MailStep({ accounts, onNext }: { accounts: Account[]; onNext: () => void }) {
  const [adding, setAdding] = useState(accounts.length === 0);
  useGoogleResult();
  const googleReady = useGoogleReady();
  return (
    <>
      <StepHeader
        title={accounts.length ? 'Your mailboxes' : 'Connect your first mailbox'}
        text={accounts.length ? 'Add every address you read, or carry on. You can always add more in Settings.' : 'Type the address and its password. Postino finds the server settings for you and checks that they work.'}
      />
      {accounts.length > 0 && (
        <ul className="wizard-accounts">
          {accounts.map((a) => (
            <li key={a.id}>
              <span className="wa-email"><span className="acct-tag" style={{ ['--c' as string]: a.color }}>{a.email}</span></span>
              <SyncState a={a} />
            </li>
          ))}
        </ul>
      )}
      <PendingMailboxes />
      {googleReady && (
        <div className="google-row">
          <GoogleSignInButton back="/welcome" />
          <span className="help">For Gmail addresses: connect with your Google account instead of a password.</span>
        </div>
      )}
      {accounts.length === 0 && (
        <div className="wizard-restore">
          <span>Moving to a new server?</span>
          <RestoreButton className="btn btn-quiet btn-sm" />
        </div>
      )}
      {adding ? (
        <MailboxForm index={accounts.length} onAdded={() => setAdding(false)} onCancel={accounts.length ? () => setAdding(false) : undefined} />
      ) : (
        <div className="wizard-actions">
          <button className="btn btn-ghost" onClick={() => setAdding(true)}><Icon name="plus" size={15} />Add another address</button>
          <button className="btn btn-primary btn-lg" onClick={onNext} disabled={!accounts.length}>Continue</button>
        </div>
      )}
    </>
  );
}

function SyncState({ a }: { a: Account }) {
  if (a.status === 'error') return <span className="wa-state err">{a.error || 'Connection problem'}</span>;
  if (a.initialSync && !a.initialSync.done && a.initialSync.total > 0)
    return <span className="wa-state">Downloading {Math.min(100, Math.round((a.initialSync.fetched / a.initialSync.total) * 100))}%</span>;
  if (a.status === 'connected') return <span className="wa-state ok"><Icon name="check" size={12} />Connected</span>;
  return <span className="wa-state">Connecting…</span>;
}

function MailboxForm({ index, onAdded, onCancel }: { index: number; onAdded: () => void; onCancel?: () => void }) {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [imap, setImap] = useState({ host: '', port: 993, secure: true });
  const [smtp, setSmtp] = useState({ host: '', port: 465, secure: true });
  const { data: existing } = useAccountsList();
  const [color, setColor] = useState(() => suggestColor('', []));
  const [colorTouched, setColorTouched] = useState(false);
  useEffect(() => {
    if (!colorTouched) setColor(suggestColor(email, existing ?? []));
  }, [email, existing, colorTouched]);
  void index;
  const [advanced, setAdvanced] = useState(false);
  const [looking, setLooking] = useState(false);
  const [found, setFound] = useState<string>('');
  const [err, setErr] = useState('');
  const lookedUp = useRef('');
  const pending = useRef<Promise<{ host: string } | null> | null>(null);
  const provider = providerFor(email);
  const googleReady = useGoogleReady();

  /** Resolves with the detected incoming host (or null). Repeated calls for the same address share one request. */
  const lookup = (): Promise<{ host: string } | null> => {
    const e = email.trim().toLowerCase();
    if (!e.includes('@')) return Promise.resolve(null);
    if (lookedUp.current === e && pending.current) return pending.current;
    lookedUp.current = e;
    setLooking(true);
    const p = (async () => {
      try {
        const r = await api.accounts.presets(e);
        if (r) {
          setImap(r.imap);
          setSmtp(r.smtp);
          setUsername(r.username);
          setFound(`Server: ${r.imap.host}`);
          return { host: r.imap.host };
        }
        setFound('');
        setAdvanced(true);
        return null;
      } catch {
        setAdvanced(true);
        return null;
      } finally {
        setLooking(false);
      }
    })();
    pending.current = p;
    return p;
  };
  useEffect(() => {
    if (!email.includes('@') || !/\.[a-z]{2,}$/i.test(email)) return;
    const t = window.setTimeout(() => void lookup(), 600);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [email]);

  const input = (): AccountInput => ({ email: email.trim(), name: name.trim() || email.trim(), password, imap, smtp, username: username.trim() || undefined, color });
  const describe = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === 'imap_login_failed') return `The incoming mail server said no. ${e.message.replace(/^Incoming mail \(IMAP\): /, '')}`;
      if (e.code === 'smtp_login_failed') return `The outgoing mail server said no. ${e.message.replace(/^Outgoing mail \(SMTP\): /, '')}`;
      return e.message;
    }
    return 'Could not reach Postino. Check your connection and try again.';
  };
  const create = useMutation({
    mutationFn: () => api.accounts.create(input()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
      onAdded();
    },
    onError: (e) => {
      setErr(describe(e));
      setAdvanced(true);
    },
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    if (!email.includes('@')) return setErr('Enter the email address first.');
    if (!password) return setErr('Enter the mailbox password.');
    const detected = pending.current ? await pending.current : null;
    if (!(imap.host || detected?.host) || !(smtp.host || detected?.host)) {
      setAdvanced(true);
      return setErr('No server settings found for this address: fill them in below (your provider lists them as IMAP and SMTP).');
    }
    create.mutate();
  };

  return (
    <form className="wizard-form" onSubmit={(e) => void submit(e)}>
      <div className="field">
        <label htmlFor="w-email">Email address</label>
        <input id="w-email" className="input input-lg" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} onBlur={() => void lookup()} placeholder="name@yourdomain.it" autoFocus />
        <span className="help lookup">{looking ? 'Looking up the server settings…' : found ? <><Icon name="check" size={12} /> {found}</> : ''}</span>
      </div>
      {provider?.name === 'Gmail' && googleReady && (
        <div className="google-row">
          <GoogleSignInButton back="/welcome" email={email} />
          <span className="help">No password to type: Google asks you to confirm.</span>
        </div>
      )}
      {provider && <p className="wizard-hint"><Icon name="alert" size={14} /><span>{provider.hint}</span></p>}
      <div className="field">
        <label htmlFor="w-pw">Mailbox password</label>
        <input id="w-pw" className="input input-lg" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="w-name">Your name, as recipients see it</label>
        <input id="w-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Anna Rossi" autoComplete="name" />
      </div>
      <div className="field">
        <span className="label">Colour for this address</span>
        <ColorPicker value={color} onChange={(c) => { setColorTouched(true); setColor(c); }} />
      </div>
      <div className="wizard-servers">
        {!advanced ? (
          <div className="ws-row">
            <Icon name="settings" size={15} />
            <span className="ws-text">
              {imap.host ? (
                <>Mail server: <b>{imap.host}</b>{smtp.host && smtp.host !== imap.host ? <> / <b>{smtp.host}</b></> : null}</>
              ) : (
                'Server settings: found automatically for most providers'
              )}
            </span>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdvanced(true)}>{imap.host ? 'Change' : 'Enter them yourself'}</button>
          </div>
        ) : (
          <>
            <div className="ws-row">
              <Icon name="settings" size={15} />
              <span className="ws-text">Server settings (your provider lists them as IMAP and SMTP)</span>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setAdvanced(false)}>Hide</button>
            </div>
            <div className="field">
              <label htmlFor="w-user">User name (usually the full address)</label>
              <input id="w-user" className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder={email || 'name@yourdomain.it'} autoCapitalize="none" />
            </div>
            <ServerFields label="Incoming (IMAP)" value={imap} onChange={setImap} idp="w-imap" />
            <ServerFields label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} idp="w-smtp" />
            <span className="help">Typical values: IMAP port 993 with TLS, SMTP port 465 with TLS (or 587 without).</span>
          </>
        )}
      </div>
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="wizard-actions">
        {onCancel && <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn btn-primary btn-lg" disabled={create.isPending}>
          {create.isPending ? 'Checking the connection…' : 'Add this mailbox'}
        </button>
      </div>
    </form>
  );
}

// ---------- 2. Phone ----------

function PhoneStep({ onNext }: { onNext: () => void }) {
  const [, bump] = useState(0);
  useEffect(() => onInstallChange(() => bump((n) => n + 1)), []);
  const p = platform();
  const installed = isInstalled();
  const install = async () => {
    const r = await promptInstall();
    if (r === 'accepted') onNext();
  };
  const steps: Record<typeof p, ReactNode> = {
    android: (
      <ol className="wizard-list">
        <li>Open this page in <b>Chrome</b> on the phone.</li>
        <li>Tap the <b>⋮ menu</b> → <b>Add to Home screen</b> (or “Install app”).</li>
        <li>Postino appears next to your other apps, full screen, with its own icon.</li>
      </ol>
    ),
    ios: (
      <ol className="wizard-list">
        <li>Open this page in <b>Safari</b>.</li>
        <li>Tap <b>Share</b> (the square with an arrow) → <b>Add to Home Screen</b>.</li>
        <li>Notifications on iPhone only work from the installed app, so do this first.</li>
      </ol>
    ),
    desktop: (
      <ol className="wizard-list">
        <li>In Chrome or Edge, click the <b>install icon</b> at the right end of the address bar (a monitor with an arrow).</li>
        <li>Postino opens in its own window and shows up in your app list.</li>
        <li>On your phone, open the same address and choose <b>Add to Home screen</b>.</li>
      </ol>
    ),
  };
  return (
    <>
      <StepHeader title="Put it on your phone" text={installed ? 'Postino is installed on this device.' : 'Postino is a web app: installing it gives you an icon, full screen and notifications. Nothing to download from a store.'} />
      {!installed && steps[p]}
      <ShareBox />
      <div className="wizard-actions">
        {!installed && canPromptInstall() ? (
          <>
            <button className="btn btn-ghost" onClick={onNext}>Later</button>
            <button className="btn btn-primary btn-lg" onClick={() => void install()}><Icon name="download" size={16} />Install now</button>
          </>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={onNext}>Continue</button>
        )}
      </div>
    </>
  );
}

function ShareBox() {
  const url = typeof window === 'undefined' ? '' : window.location.origin;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="wizard-share">
      <span className="help">Address to open on your other devices</span>
      <div className="row-inline" style={{ flexWrap: 'nowrap' }}>
        <code className="wizard-url">{url}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
    </div>
  );
}

// ---------- 3. Notifications ----------

function NotifyStep({ onNext }: { onNext: () => void }) {
  const { data: me } = useMe();
  const { data: s } = useSettings();
  const update = useUpdateSettings();
  const [state, setState] = useState<'idle' | 'busy' | 'on' | 'denied' | 'unsupported'>('idle');
  useEffect(() => {
    void currentSubscription().then((sub) => sub && setState('on'));
  }, []);
  const supported = pushSupported();
  const enable = async () => {
    if (!me) return;
    setState('busy');
    try {
      const r = await enablePush(me.vapidPublicKey);
      if (r === 'ok') {
        await update.mutateAsync({ notifications: { enabled: true, categories: s?.notifications.categories ?? ['person'] } });
        setState('on');
      } else setState(r);
    } catch {
      setState('denied');
    }
  };
  return (
    <>
      <StepHeader title="New mail, as it arrives" text="A normal notification on this device when a person writes to you. Newsletters and automatic mail stay quiet; you can change that in Settings." />
      {!supported && (
        <p className="wizard-hint"><Icon name="alert" size={14} /><span>{platform() === 'ios' ? 'On iPhone, notifications only work after Postino is added to the Home Screen. Open it from there and enable them in Settings → Notifications.' : 'This browser cannot show push notifications. Try Chrome, or enable them later from Settings.'}</span></p>
      )}
      {state === 'denied' && <p className="error-text" role="alert">Notifications are blocked for this site. Allow them in the browser's site settings, then try again.</p>}
      {state === 'on' && <p className="wizard-ok"><Icon name="check" size={14} />Notifications are on for this device.</p>}
      <div className="wizard-actions">
        {state !== 'on' && <button className="btn btn-ghost" onClick={onNext}>Not now</button>}
        {state === 'on' || !supported ? (
          <button className="btn btn-primary btn-lg" onClick={onNext}>Continue</button>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={() => void enable()} disabled={state === 'busy'}><Icon name="bell" size={16} />{state === 'busy' ? 'Waiting for the browser…' : 'Turn on notifications'}</button>
        )}
      </div>
    </>
  );
}

// ---------- 4. Passkey ----------

function PasskeyStep({ onNext }: { onNext: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['passkeys'], queryFn: api.passkeys.list });
  const supported = typeof window !== 'undefined' && browserSupportsWebAuthn();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // Adding a device needs a recent sign-in; after a while the password is asked again.
  const [needPw, setNeedPw] = useState(false);
  const [pw, setPw] = useState('');
  const has = (data?.passkeys?.length ?? 0) > 0;
  const add = async () => {
    setErr('');
    setBusy(true);
    try {
      let options;
      try {
        options = await api.passkeys.registerOptions(pw || undefined);
      } catch (e) {
        if ((e as { code?: string }).code === 'reauth_required') {
          setNeedPw(true);
          setErr(pw ? 'Wrong password. Try again.' : '');
          return;
        }
        throw e;
      }
      const response = await startRegistration({ optionsJSON: options });
      const name = platform() === 'android' ? 'Android phone' : platform() === 'ios' ? 'iPhone' : /Mac/i.test(navigator.userAgent) ? 'Mac' : /Windows/i.test(navigator.userAgent) ? 'Windows PC' : 'This device';
      await api.passkeys.registerVerify(response, name);
      try {
        localStorage.setItem('postino.passkey', '1');
      } catch {
        /* ignore */
      }
      qc.invalidateQueries({ queryKey: ['passkeys'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      if ((e as Error).name === 'NotAllowedError') setErr('Cancelled. You can add it later from Settings → Security.');
      else if ((e as Error).name === 'InvalidStateError') setErr('This device is already registered.');
      else setErr((e as Error).message || 'Could not add the passkey.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <StepHeader title="Sign in with your fingerprint" text="Next time, unlock Postino with your fingerprint, face or device PIN instead of the password. Each phone or computer is added once." />
      {!supported && <p className="wizard-hint"><Icon name="alert" size={14} /><span>This browser does not support passkeys. The password keeps working.</span></p>}
      {has && <p className="wizard-ok"><Icon name="check" size={14} />Fingerprint sign-in is set up on this device.</p>}
      {needPw && !has && (
        <div className="field">
          <label htmlFor="w-pk-pw">Your Postino password (to confirm it is you)</label>
          <input id="w-pk-pw" className="input input-lg" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && pw) void add(); }} autoFocus />
        </div>
      )}
      {err && <p className="error-text" role="alert">{err}</p>}
      <div className="wizard-actions">
        {!has && <button className="btn btn-ghost" onClick={onNext}>Skip</button>}
        {has || !supported ? (
          <button className="btn btn-primary btn-lg" onClick={onNext}>Continue</button>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={() => void add()} disabled={busy || (needPw && !pw)}><Icon name="fingerprint" size={16} />{busy ? 'Waiting for the device…' : 'Add this device'}</button>
        )}
      </div>
    </>
  );
}

// ---------- 5. Done ----------

function DoneStep({ accounts, onFinish }: { accounts: Account[]; onFinish: () => void }) {
  const toast = useUI((s) => s.toast);
  const syncing = accounts.filter((a) => a.initialSync && !a.initialSync.done);
  useEffect(() => {
    if (syncing.length) toast({ text: 'Older mail keeps downloading in the background.' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="wizard-done-mark"><Icon name="sparkle" size={28} /></div>
      <StepHeader title="You're all set" text={`${accounts.length === 1 ? 'Your mailbox is' : `${accounts.length} mailboxes are`} connected. New mail lands in one inbox; People, Notifications and Newsletters are kept apart.`} />
      <ul className="wizard-list tips">
        <li><b>Block sender</b> on any message: their mail goes to Blocked before you see it, on every device.</li>
        <li><b>Signatures</b>, reply-from-the-same-address, undo send and send later live in <b>Settings</b>.</li>
        <li>Press <b>?</b> on a computer for the keyboard shortcuts.</li>
      </ul>
      <div className="wizard-actions">
        <button className="btn btn-primary btn-lg" onClick={onFinish}><Icon name="inbox" size={16} />Open my inbox</button>
      </div>
    </>
  );
}
