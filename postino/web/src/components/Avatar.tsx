import { useEffect, useState } from 'react';
import type { Address } from '../api/types';
import { displayName } from '../util/format';

// Gmail's avatar colours: each sender keeps the same one everywhere.
const PALETTE = ['#e8710a', '#1a73e8', '#d93025', '#188038', '#9334e6', '#e52592', '#12b5cb', '#f9ab00', '#5f6368', '#c5221f', '#0b8043', '#a142f4'];
function senderColor(key: string): string {
  let h = 7;
  for (const c of key.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
/** One letter, like Gmail: the first letter of the name (or of the address). */
function letter(who: Address | string): string {
  const n = typeof who === 'string' ? who : displayName(who);
  const m = n.match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : '?';
}

/**
 * A sender's picture: Gravatar or company logo served by our server, with the
 * initials shown underneath until it loads (and kept when there is none).
 */
export function Avatar({ who, color, small, me, label }: { who: Address | string; color?: string; small?: boolean; me?: boolean; label?: string }) {
  const email = typeof who === 'string' ? who : who.email;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const showImg = !me && email && email.includes('@') && !failed;
  // A cold server cache answers "none" and looks the picture up in the background: try once more later.
  useEffect(() => {
    if (!failed || attempt > 0) return;
    const t = window.setTimeout(() => {
      setAttempt(1);
      setFailed(false);
    }, 25_000);
    return () => window.clearTimeout(t);
  }, [failed, attempt]);
  return (
    <div className={`av${small ? ' sm' : ''}${me ? ' me' : ''}${loaded ? ' has-img' : ''}`} style={{ ['--c' as string]: me ? color : senderColor(email || String(who)) }} aria-hidden="true">
      {label ?? (me ? 'Me' : letter(who))}
      {showImg && (
        <img
          src={`/api/avatar?email=${encodeURIComponent(email)}${attempt ? `&r=${attempt}` : ''}`}
          alt=""
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
