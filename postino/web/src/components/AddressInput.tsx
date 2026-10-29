import { useEffect, useRef, useState } from 'react';
import { api } from '../api/client';
import type { Address } from '../api/types';
import { displayName, formatAddress, initials } from '../util/format';

/** A comma-separated address field with contact suggestions for the token being typed. */
export function AddressInput({ id, label, value, onChange, autoFocus, compact }: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
  compact?: boolean;
}) {
  const [sugs, setSugs] = useState<Address[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  const token = value.split(',').pop()?.trim() ?? '';

  useEffect(() => {
    if (!open || token.length < 1) {
      setSugs([]);
      return;
    }
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await api.contacts(token, 6);
        if (alive) setSugs(r);
      } catch {
        /* ignore */
      }
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [token, open]);

  const pick = (a: Address) => {
    const parts = value.split(',');
    parts.pop();
    const next = [...parts.map((p) => p.trim()).filter(Boolean), formatAddress(a)].join(', ') + ', ';
    onChange(next);
    setSugs([]);
    setActive(-1);
    ref.current?.focus();
  };

  const field = (
    <>
      <input
        id={id}
        ref={ref}
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={compact ? label : ''}
        autoFocus={autoFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
          setActive(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Enter confirms the address being typed; it must never send the email.
            e.preventDefault();
            if (sugs.length && active >= 0) return pick(sugs[active]);
            const v = value.trim();
            if (v && !v.endsWith(',')) onChange(v + ', ');
            setSugs([]);
            return;
          }
          if (!sugs.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, sugs.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, -1));
          } else if (e.key === 'Tab' && active >= 0) {
            e.preventDefault();
            pick(sugs[active]);
          } else if (e.key === 'Escape') {
            setSugs([]);
          }
        }}
        aria-autocomplete="list"
        aria-expanded={open && sugs.length > 0}
      />
      {open && sugs.length > 0 && (
        <div className="sugs" role="listbox">
          {sugs.map((a, i) => (
            <button key={a.email} type="button" className={`sug${active === i ? ' on' : ''}`} role="option" aria-selected={active === i} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(a)}>
              <span className="av">{initials(a)}</span>
              <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                <span>{displayName(a)}</span>
                <small>{a.email}</small>
              </span>
            </button>
          ))}
        </div>
      )}
    </>
  );

  if (compact)
    return (
      <div className="cfield" style={{ padding: 0, minHeight: 36, borderBottom: '1px solid var(--line)' }}>
        <label htmlFor={id} style={{ width: 40 }}>{label}</label>
        {field}
      </div>
    );
  return (
    <div className="cfield">
      <label htmlFor={id}>{label}</label>
      {field}
    </div>
  );
}
