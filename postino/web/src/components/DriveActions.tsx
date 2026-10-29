import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { Attachment } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';

/** Which Google editor can open this file, if any. */
export function googleAppFor(a: Attachment): 'document' | 'spreadsheet' | 'presentation' | null {
  const ext = (a.filename.split('.').pop() ?? '').toLowerCase();
  const t = a.contentType.toLowerCase();
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext) || t.includes('wordprocessingml') || t === 'application/msword' || t === 'application/vnd.oasis.opendocument.text') return 'document';
  if (['xls', 'xlsx', 'ods', 'csv', 'tsv'].includes(ext) || t.includes('spreadsheetml') || t === 'application/vnd.ms-excel' || t === 'text/csv') return 'spreadsheet';
  if (['ppt', 'pptx', 'odp'].includes(ext) || t.includes('presentationml') || t === 'application/vnd.ms-powerpoint') return 'presentation';
  return null;
}

export function useDriveStatus() {
  return useQuery({ queryKey: ['google'], queryFn: api.google.status, staleTime: 60_000, retry: false });
}

/**
 * "Save to Drive" and "Open in Google Docs/Sheets/Slides" for an attachment.
 * Shown only when a Google account is connected (Settings → Google).
 */
export function DriveActions({ attachment: a, compact }: { attachment: Attachment; compact?: boolean }) {
  const { data } = useDriveStatus();
  const toast = useUI((s) => s.toast);
  const [busy, setBusy] = useState<'save' | 'open' | null>(null);
  if (!data?.connected) return null;
  const app = googleAppFor(a);
  const appName = app === 'document' ? 'Google Docs' : app === 'spreadsheet' ? 'Google Sheets' : app === 'presentation' ? 'Google Slides' : null;
  const run = async (mode: 'save' | 'open') => {
    setBusy(mode);
    // Open the tab first (allowed in the click handler), then point it at the file.
    const win = window.open('', '_blank');
    try {
      const r = await api.google.save(a.id, mode === 'open' && app ? app : undefined);
      if (win) win.location.href = r.webViewLink;
      else window.open(r.webViewLink, '_blank', 'noopener');
      toast({ text: mode === 'open' ? `Opened in ${appName}` : 'Saved to Google Drive', kind: 'success' });
    } catch (e) {
      win?.close();
      toast({ text: (e as Error).message || 'Google Drive did not accept the file.', kind: 'error' });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      {appName && (
        <button className={`btn btn-ghost drive${compact ? ' btn-sm' : ''}`} onClick={() => void run('open')} disabled={busy !== null} title={`Open a copy in ${appName}`}>
          <Icon name="external" size={15} />
          {busy === 'open' ? 'Opening…' : `Open in ${appName}`}
        </button>
      )}
      <button className={`btn btn-ghost drive${compact ? ' btn-sm' : ''}`} onClick={() => void run('save')} disabled={busy !== null} title="Save a copy in your Google Drive">
        <Icon name="folder" size={15} />
        {busy === 'save' ? 'Saving…' : 'Save to Drive'}
      </button>
    </>
  );
}
