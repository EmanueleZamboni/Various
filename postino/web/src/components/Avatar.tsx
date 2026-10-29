import { useState } from 'react';
import type { Address } from '../api/types';
import { initials } from '../util/format';

/**
 * A sender's picture: Gravatar or company logo served by our server, with the
 * initials shown underneath until it loads (and kept when there is none).
 */
export function Avatar({ who, color, small, me, label }: { who: Address | string; color?: string; small?: boolean; me?: boolean; label?: string }) {
  const email = typeof who === 'string' ? who : who.email;
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const showImg = !me && email && email.includes('@') && !failed;
  return (
    <div className={`av${small ? ' sm' : ''}${me ? ' me' : ''}${loaded ? ' has-img' : ''}`} style={{ ['--c' as string]: color }} aria-hidden="true">
      {label ?? (me ? 'Me' : initials(who))}
      {showImg && (
        <img
          src={`/api/avatar?email=${encodeURIComponent(email)}`}
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
