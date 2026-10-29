import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api/client';
import type { Address } from '../api/types';
import { Icon } from '../icons';
import { useNav } from '../nav';
import { displayName, initials } from '../util/format';

const OPERATORS: { op: string; hint: string }[] = [
  { op: 'from:', hint: 'sender' },
  { op: 'to:', hint: 'recipient' },
  { op: 'subject:', hint: 'words in the subject' },
  { op: 'has:attachment', hint: 'with files' },
  { op: 'is:unread', hint: 'unread only' },
  { op: 'is:pinned', hint: 'pinned only' },
  { op: 'in:archive', hint: 'a folder: inbox, sent, archive, junk, trash' },
  { op: 'after:', hint: 'after a date, e.g. after:2026-09-01' },
  { op: 'before:', hint: 'before a date' },
  { op: 'newer_than:7d', hint: 'last days, weeks (2w) or months (1m)' },
  { op: 'account:', hint: 'one mailbox' },
];

function lastToken(s: string) {
  const m = s.match(/(?:^|\s)(\S*)$/);
  return m ? m[1] : '';
}

export function SearchBar() {
  const nav = useNav();
  const [value, setValue] = useState(nav.q);
  const [open, setOpen] = useState(false);
  const [contacts, setContacts] = useState<Address[]>([]);
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const prevView = useRef(nav.view === 'search' ? 'inbox' : nav.view);

  useEffect(() => {
    setValue(nav.q);
  }, [nav.q]);
  useEffect(() => {
    if (nav.view !== 'search') prevView.current = nav.view;
  }, [nav.view]);

  const token = lastToken(value);
  const addrMode = /^(from|to):/i.test(token);
  const addrQuery = addrMode ? token.slice(token.indexOf(':') + 1) : '';

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const t = window.setTimeout(async () => {
      try {
        const r = await api.search.suggest(addrMode ? addrQuery : value.trim());
        if (!alive) return;
        setContacts(r.contacts);
        setRecent(r.recent);
      } catch {
        /* ignore */
      }
    }, 120);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [open, value, addrMode, addrQuery]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const run = (q: string) => {
    const trimmed = q.trim();
    setOpen(false);
    if (!trimmed) return clear();
    nav.search(trimmed);
  };
  const clear = () => {
    setValue('');
    setOpen(false);
    if (nav.view === 'search') nav.go(prevView.current || 'inbox');
  };
  const replaceToken = (replacement: string) => {
    const base = value.replace(/(\S*)$/, '');
    const next = `${base}${replacement}`;
    setValue(next);
    inputRef.current?.focus();
    setActive(-1);
    return next;
  };

  const suggestions: { kind: 'contact' | 'recent' | 'op'; label: string; apply: () => void; a?: Address }[] = [];
  if (addrMode) {
    for (const c of contacts) {
      const op = token.slice(0, token.indexOf(':') + 1);
      suggestions.push({ kind: 'contact', label: displayName(c), a: c, apply: () => run(replaceToken(`${op}${c.email} `)) });
    }
  } else if (!value.trim()) {
    for (const r of recent) suggestions.push({ kind: 'recent', label: r, apply: () => run(r) });
  } else {
    for (const c of contacts.slice(0, 3)) suggestions.push({ kind: 'contact', label: displayName(c), a: c, apply: () => run(`from:${c.email}`) });
  }

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' && suggestions.length) {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp' && suggestions.length) {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && suggestions[active]) suggestions[active].apply();
      else run(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open) setOpen(false);
      else clear();
      inputRef.current?.blur();
    } else if (e.key === 'Tab' && addrMode && suggestions[0]) {
      e.preventDefault();
      suggestions[0].apply();
    }
  };

  return (
    <div className="search" ref={boxRef}>
      <label className="search-box" htmlFor="search-input">
        <Icon name="search" size={17} />
        <input
          id="search-input"
          ref={inputRef}
          type="search"
          placeholder={nav.accountId ? 'Search this mailbox' : 'Search all mail'}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKey}
          aria-expanded={open}
          aria-controls="search-pop"
          role="combobox"
        />
        {value ? (
          <button className="ib" aria-label="Clear search" onMouseDown={(e) => e.preventDefault()} onClick={clear}>
            <Icon name="x" size={16} />
          </button>
        ) : (
          <span className="kbd" aria-hidden="true">/</span>
        )}
      </label>
      {open && (
        <div className="search-pop" id="search-pop" role="listbox">
          {suggestions.length > 0 && (
            <>
              <div className="sec">{addrMode ? 'People' : value.trim() ? 'People' : 'Recent'}</div>
              {suggestions.map((s, i) => (
                <button key={`${s.kind}-${s.label}-${i}`} className={`sug${active === i ? ' on' : ''}`} role="option" aria-selected={active === i} onMouseDown={(e) => e.preventDefault()} onClick={s.apply}>
                  {s.kind === 'contact' && s.a ? (
                    <>
                      <span className="av">{initials(s.a)}</span>
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span>{s.label}</span>
                        <small>{s.a.email}</small>
                      </span>
                    </>
                  ) : (
                    <>
                      <Icon name="search" size={15} />
                      <code>{s.label}</code>
                    </>
                  )}
                </button>
              ))}
            </>
          )}
          {!addrMode && (
            <>
              <div className="sec">Narrow it down</div>
              <div className="ops">
                {OPERATORS.map((o) => (
                  <button key={o.op} className="op" title={o.hint} onMouseDown={(e) => e.preventDefault()} onClick={() => { setValue((v) => (v.trim() ? v.trimEnd() + ' ' : '') + o.op); inputRef.current?.focus(); setActive(-1); }}>
                    {o.op}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
