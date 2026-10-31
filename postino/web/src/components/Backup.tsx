import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import type { PendingMailbox } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';

export const useBackupStatus = () => useQuery({ queryKey: ['backup'], queryFn: api.backup.status, staleTime: 30_000 });

/** "Restore from a backup file": reads the JSON the Backup page downloads (or the copy in Drive). */
export function RestoreButton({ className = 'btn btn-ghost' }: { className?: string }) {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File) => {
    setBusy(true);
    try {
      const json = JSON.parse(await file.text()) as unknown;
      const r = await api.backup.restore(json);
      toast({ text: r.mailboxes.length ? 'Backup restored. Now type the password of each mailbox.' : 'Backup restored.', kind: 'success' });
      for (const k of ['backup', 'settings', 'templates', 'signatures', 'blocked', 'accounts', 'drafts']) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast({ text: e instanceof SyntaxError ? 'That file is not a Postino backup.' : (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  return (
    <>
      <button type="button" className={className} disabled={busy} onClick={() => input.current?.click()}>
        <Icon name="undo" size={18} />
        {busy ? 'Restoring…' : 'Restore from a backup'}
      </button>
      <input ref={input} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
    </>
  );
}

/** Mailboxes from a restored backup: everything is known except the password, which backups never hold. */
export function PendingMailboxes() {
  const { data } = useBackupStatus();
  const qc = useQueryClient();
  const pending = data?.pendingMailboxes ?? [];
  if (!pending.length) return null;
  return (
    <div className="pending-box">
      <p className="help">From your backup: type each mailbox's password to reconnect it. Its colour, signatures and drafts come back with it.</p>
      {pending.map((m) => <PendingRow key={m.email} m={m} />)}
      <button type="button" className="btn btn-quiet btn-sm" onClick={async () => { await api.backup.forgetPending(); qc.invalidateQueries({ queryKey: ['backup'] }); }}>
        Skip the rest
      </button>
    </div>
  );
}

function PendingRow({ m }: { m: PendingMailbox }) {
  const qc = useQueryClient();
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const connect = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.accounts.create({ email: m.email, name: m.name, password: pw, username: m.username || m.email, imap: m.imap, smtp: m.smtp, color: m.color || undefined });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      qc.invalidateQueries({ queryKey: ['backup'] });
      qc.invalidateQueries({ queryKey: ['signatures'] });
      qc.invalidateQueries({ queryKey: ['drafts'] });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="pending-row" onSubmit={(e) => { e.preventDefault(); if (pw) void connect(); }}>
      <span className="acct-tag" style={{ ['--c' as string]: m.color }}>{m.email}</span>
      <input className="input" type="password" autoComplete="off" placeholder="Mailbox password" aria-label={`Password for ${m.email}`} value={pw} onChange={(e) => setPw(e.target.value)} />
      <button className="btn btn-primary btn-sm" disabled={!pw || busy}>{busy ? 'Checking…' : 'Connect'}</button>
      {err && <span className="pending-err" role="alert">{err}</span>}
    </form>
  );
}

/** Settings → Backup */
export function BackupSettings() {
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const { data } = useBackupStatus();
  const [busy, setBusy] = useState(false);
  const driveNow = async () => {
    setBusy(true);
    try {
      await api.backup.driveNow();
      toast({ text: 'Backup saved in Google Drive', kind: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, kind: 'error' });
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['backup'] });
    }
  };
  const when = data?.lastDrive ? new Date(data.lastDrive).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div className="settings-section">
      <h2>Backup</h2>
      <p className="help">
        Your emails, read/unread and stars live on your mail servers and are never lost. The backup keeps what lives only in Postino: settings, templates,
        signatures, blocked senders, unsent drafts and which mailboxes you use. It is a small file (a few KB). Passwords are never included.
      </p>
      <div className="card backup-card">
        <div className="backup-line">
          <Icon name="download" size={22} />
          <div>
            <b>Download a backup</b>
            <small>A file you keep on your computer or phone.</small>
          </div>
          <a className="btn btn-ghost" href="/api/backup" download>Download</a>
        </div>
        <div className="backup-line">
          <Icon name="folder" size={22} />
          <div>
            <b>Automatic copy in Google Drive</b>
            <small>
              {!data?.driveConnected
                ? 'Connect Google Drive (Settings → Google Drive) and Postino saves a copy every night in a "Postino backups" folder. Copies older than 30 days are deleted.'
                : data.lastDriveError
                  ? `Last try failed: ${data.lastDriveError}`
                  : when
                    ? `Every night, in "Postino backups". Last copy: ${when}. Copies older than 30 days are deleted.`
                    : 'Every night, in "Postino backups". The first copy is made within the hour.'}
            </small>
          </div>
          {data?.driveConnected && <button className="btn btn-ghost" disabled={busy} onClick={() => void driveNow()}>{busy ? 'Saving…' : 'Back up now'}</button>}
        </div>
        <div className="backup-line">
          <Icon name="undo" size={22} />
          <div>
            <b>Restore</b>
            <small>On a new server: pick the backup file, then type each mailbox's password.</small>
          </div>
          <RestoreButton />
        </div>
      </div>
      <PendingMailboxes />
    </div>
  );
}
