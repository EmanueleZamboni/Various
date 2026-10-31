import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';
import { useTemplates } from '../api/hooks';
import type { Template } from '../api/types';
import { Icon } from '../icons';
import { useUI } from '../store';

/** "{nome}" / "{name}" in a template become the first recipient's first name. */
export function fillTemplate(text: string, toField: string): string {
  const first = toField.split(/[,;]/)[0] ?? '';
  const named = /^\s*"?([^"<@]+?)"?\s*</.exec(first)?.[1]?.trim();
  const local = /([^\s<@"]+)@/.exec(first)?.[1] ?? '';
  const guess = named ? named.split(/\s+/)[0] : local.split(/[._-]/)[0];
  const name = guess ? guess.charAt(0).toUpperCase() + guess.slice(1) : '';
  return text.replace(/\{(nome|name)\}/gi, name).replace(/^Ciao ,/m, 'Ciao,').replace(/^Hi ,/m, 'Hi,');
}

/** Toolbar button: pick a template to insert, or save what you wrote as a new one. */
export function TemplatePicker({ onPick, current }: { onPick: (t: Template) => void; current?: { subject: string; text: string } }) {
  const { data: templates } = useTemplates();
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  const [open, setOpen] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setNaming(false);
      }
    };
    document.addEventListener('mousedown', off);
    return () => document.removeEventListener('mousedown', off);
  }, [open]);
  const save = async () => {
    if (!name.trim() || !current) return;
    await api.templates.create({ name: name.trim(), subject: current.subject, text: current.text });
    qc.invalidateQueries({ queryKey: ['templates'] });
    toast({ text: `Template "${name.trim()}" saved`, kind: 'success' });
    setName('');
    setNaming(false);
    setOpen(false);
  };
  return (
    <div className="tpl-picker" ref={ref}>
      <button type="button" className="ib" title="Templates" aria-label="Templates" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon name="draft" size={18} />
      </button>
      {open && (
        <div className="menu tpl-menu" role="menu">
          <div className="tpl-head">Templates</div>
          {(templates ?? []).map((t) => (
            <button type="button" role="menuitem" key={t.id} onClick={() => { onPick(t); setOpen(false); }}>
              <b>{t.name}</b>
              <small>{t.text.replace(/\s+/g, ' ').slice(0, 60)}</small>
            </button>
          ))}
          {!templates?.length && <div className="tpl-empty">No templates yet.</div>}
          {current && (current.text.trim() || current.subject.trim()) && (
            naming ? (
              <form className="tpl-save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
                <input className="input" placeholder="Template name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                <button type="submit" className="btn btn-primary btn-sm" disabled={!name.trim()}>Save</button>
              </form>
            ) : (
              <button type="button" role="menuitem" className="tpl-new" onClick={() => setNaming(true)}><Icon name="plus" size={14} />Save this email as a template</button>
            )
          )}
        </div>
      )}
    </div>
  );
}
