import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, type SpamVerdict } from '../api/client';
import { Icon, type IconName } from '../icons';

/** "Is this spam?": Claude's verdict on the newest received email of a conversation. Asked only on a tap. */
export function useAiSpamCheck(threadId: string | null) {
  const qc = useQueryClient();
  // A verdict Claude already gave is free to show again.
  const stored = useQuery({ queryKey: ['aiVerdict', threadId], queryFn: () => api.ai.verdict(threadId!), enabled: !!threadId, staleTime: Infinity });
  const m = useMutation({
    mutationFn: (v: { id: string; fresh: boolean }) => api.ai.spamCheck(v.id, v.fresh),
    onSuccess: (v, vars) => {
      qc.setQueryData(['aiVerdict', vars.id], { verdict: v });
      qc.invalidateQueries({ queryKey: ['aiStatus'] });
    },
  });
  const { reset } = m;
  useEffect(() => reset(), [threadId, reset]);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => setDismissed(null), [threadId]);
  return {
    verdict: dismissed === threadId ? null : stored.data?.verdict ?? null,
    loading: m.isPending,
    error: m.error as (Error & { code?: string }) | null,
    run: (fresh = false) => {
      if (!threadId) return;
      setDismissed(null);
      m.mutate({ id: threadId, fresh });
    },
    dismiss: () => {
      reset();
      setDismissed(threadId);
    },
  };
}

const LOOK: Record<SpamVerdict['verdict'], { title: string; tone: string; icon: IconName }> = {
  safe: { title: 'Looks legitimate', tone: 'ok', icon: 'shield' },
  spam: { title: 'Spam', tone: 'warn', icon: 'spam' },
  suspicious: { title: 'Suspicious', tone: 'warn', icon: 'alert' },
  phishing: { title: 'Phishing', tone: 'bad', icon: 'alert' },
  scam: { title: 'Scam', tone: 'bad', icon: 'alert' },
};
const SURE: Record<SpamVerdict['confidence'], string> = { high: 'Claude is sure', medium: 'Claude is fairly sure', low: 'Claude is not sure' };

export function AiVerdictPanel({
  check,
  senderEmail,
  inSpam,
  onFile,
}: {
  check: ReturnType<typeof useAiSpamCheck>;
  senderEmail: string;
  inSpam: boolean;
  onFile: (block: boolean) => void;
}) {
  const navigate = useNavigate();
  if (check.loading) {
    return (
      <div className="ai-verdict loading" role="status">
        <span className="ai-spin" aria-hidden="true" />
        <span>Claude is checking this email…</span>
      </div>
    );
  }
  if (check.error) {
    const code = (check.error as { code?: string }).code ?? '';
    const needsSetup = ['ai_off', 'ai_key', 'ai_cap'].includes(code) || /Settings › Claude/.test(check.error.message);
    return (
      <div className="ai-verdict bad" role="alert">
        <div className="ai-top">
          <Icon name="alert" size={20} />
          <b>Could not check</b>
          <button className="ib" aria-label="Close" onClick={check.dismiss}><Icon name="x" size={18} /></button>
        </div>
        <p>{check.error.message}</p>
        <div className="ai-actions">
          {needsSetup ? (
            <button className="btn btn-primary btn-sm" onClick={() => navigate('/settings/claude')}>Open settings</button>
          ) : (
            <button className="btn btn-ghost btn-sm" onClick={() => check.run()}>Try again</button>
          )}
        </div>
      </div>
    );
  }
  const v = check.verdict;
  if (!v) return null;
  const look = LOOK[v.verdict] ?? LOOK.suspicious;
  const bad = v.verdict !== 'safe';
  return (
    <div className={`ai-verdict ${look.tone}`} role="status">
      <div className="ai-top">
        <Icon name={look.icon} size={20} />
        <b>{look.title}</b>
        <span className="ai-sure">{SURE[v.confidence] ?? ''}</span>
        <button className="ib" aria-label="Close" onClick={check.dismiss}><Icon name="x" size={18} /></button>
      </div>
      <p>{v.summary}</p>
      {v.reasons.length > 0 && (
        <ul>
          {v.reasons.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      )}
      {bad && !inSpam ? (
        <>
          <p className="ai-ask">Block <b>{senderEmail}</b>, or just move this email to spam?</p>
          <div className="ai-actions">
            <button className="btn btn-primary btn-sm" onClick={() => onFile(true)}>Block sender</button>
            <button className="btn btn-ghost btn-sm" onClick={() => onFile(false)}>Only to spam</button>
            <button className="btn btn-quiet btn-sm" onClick={check.dismiss}>Keep it</button>
          </div>
        </>
      ) : (
        <div className="ai-actions">
          <button className="btn btn-quiet btn-sm" onClick={() => check.run(true)}>Check again</button>
        </div>
      )}
    </div>
  );
}
