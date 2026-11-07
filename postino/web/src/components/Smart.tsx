import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type PointerEvent } from 'react';
import { api } from '../api/client';
import type { SmartCard, UpcomingItem } from '../api/types';
import { Icon, type IconName } from '../icons';
import { useUI } from '../store';

/** "Tue 10 Nov", or "today" / "tomorrow". Days are YYYY-MM-DD in Italian time. */
function dayLabel(day: string): string {
  if (!day) return '';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date(Date.now() + 86_400_000));
  if (day === today) return 'today';
  if (day === tomorrow) return 'tomorrow';
  const d = new Date(`${day}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
/** "Fri 6 Nov, 15:09" from "2026-11-06T15:09" (local time as printed on the ticket). */
function whenLabel(local: string): string {
  if (!local) return '';
  const day = dayLabel(local.slice(0, 10));
  return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ${local.slice(11, 16)}`;
}

export function packageLine(c: Extract<SmartCard, { kind: 'package' }>): string {
  const by = c.expected ? dayLabel(c.expected) : '';
  switch (c.status) {
    case 'delivered':
      return 'Delivered';
    case 'out_for_delivery':
      return 'Out for delivery today';
    case 'problem':
      return 'Delivery problem: see the email';
    case 'ordered':
      return by ? `Ordered · arriving ${by}` : 'Ordered';
    default:
      return by ? `Arriving ${by === 'today' || by === 'tomorrow' ? by : `by ${by}`}` : 'On its way';
  }
}
export function tripLine(c: Extract<SmartCard, { kind: 'trip' }>): string {
  return `${whenLabel(c.depart)} · ${c.from} → ${c.to}`;
}
const tripIcon = (c: Extract<SmartCard, { kind: 'trip' }>): IconName => (c.mode === 'flight' ? 'flight' : c.mode === 'bus' ? 'bus' : 'train');

const openLink = (url: string) => (e: React.MouseEvent) => {
  e.stopPropagation();
  window.open(url, '_blank', 'noopener,noreferrer');
};

/** Under the snippet in the list, like Gmail's "Track package · Arriving by Tue 10 Nov". */
export function SmartChip({ card }: { card: SmartCard }) {
  if (card.kind === 'package') {
    return (
      <span className="smart-chip">
        {card.trackingUrl && card.status !== 'delivered' && (
          <button type="button" className="smart-btn" onClick={openLink(card.trackingUrl)} onPointerDown={(e) => e.stopPropagation()}>
            Track package
          </button>
        )}
        <span className={`smart-info${card.status === 'problem' ? ' bad' : ''}`}>
          <Icon name="shipping" size={16} />
          {packageLine(card)}
        </span>
      </span>
    );
  }
  return (
    <span className="smart-chip">
      <span className="smart-info">
        <Icon name={tripIcon(card)} size={16} />
        {tripLine(card)}
      </span>
    </span>
  );
}

/** At the top of an email: the details Gmail shows in its summary card. */
export function SmartCardView({ card }: { card: SmartCard }) {
  if (card.kind === 'package') {
    return (
      <div className="smart-card">
        <div className="smart-card-icon"><Icon name="shipping" size={22} /></div>
        <div className="smart-card-body">
          <b>{card.title}</b>
          <span>{packageLine(card)}</span>
          <small>
            {[card.merchant, card.orderId && `Order ${card.orderId}`, card.carrier, card.trackingNumber && `Tracking ${card.trackingNumber}`].filter(Boolean).join(' · ')}
          </small>
        </div>
        {card.trackingUrl && (
          <button type="button" className="btn btn-primary btn-sm" onClick={openLink(card.trackingUrl)}>Track package</button>
        )}
      </div>
    );
  }
  return (
    <div className="smart-card">
      <div className="smart-card-icon"><Icon name={tripIcon(card)} size={22} /></div>
      <div className="smart-card-body">
        <b>{card.from} → {card.to}</b>
        <span>
          {whenLabel(card.depart)}
          {card.arrive ? ` – ${card.arrive.slice(11, 16)}` : ''}
          {card.number ? ` · ${card.number}` : ''}
        </span>
        <small>{[card.operator, card.seat, card.bookingRef].filter(Boolean).join(' · ')}</small>
      </div>
    </div>
  );
}

/** Top of the inbox: one line, like Groups, that opens to the parcels on their way and trips coming up. */
export function UpcomingBlock({ onOpen }: { onOpen: (threadId: string) => void }) {
  const { data } = useQuery({ queryKey: ['smartUpcoming'], queryFn: api.smart.upcoming, staleTime: 60_000, refetchInterval: 5 * 60_000 });
  const open = useUI((s) => !!s.bundlesOpen.upcoming);
  const toggle = useUI((s) => s.toggleBundle);
  const items = [...(data?.trips ?? []), ...(data?.packages ?? [])].sort((a, b) => urgency(a.card) - urgency(b.card));
  const qc = useQueryClient();
  const toast = useUI((s) => s.toast);
  /** Gone at once; Undo puts it back (on every device: the server keeps the list). */
  const hide = async (it: UpcomingItem) => {
    const key = ['smartUpcoming'];
    const before = qc.getQueryData<{ packages: UpcomingItem[]; trips: UpcomingItem[] }>(key);
    const drop = (l: UpcomingItem[]) => l.filter((x) => x.key !== it.key);
    qc.setQueryData<{ packages: UpcomingItem[]; trips: UpcomingItem[] }>(key, (d) => (d ? { packages: drop(d.packages), trips: drop(d.trips) } : d));
    try {
      await api.smart.hide(it.key);
      toast({
        text: 'Removed from Upcoming',
        undo: async () => {
          await api.smart.hide(it.key, false);
          qc.invalidateQueries({ queryKey: key });
        },
      });
    } catch (e) {
      qc.setQueryData(key, before);
      toast({ text: (e as Error).message, kind: 'error' });
    }
  };
  if (!items.length) return null;
  const top = items[0].card;
  const today = items.filter((it) => isToday(it.card)).length;
  return (
    <section className={`bundle groups-row upcoming-row${open ? ' open' : ''}`} aria-label="Upcoming">
      <button className="bundle-head" onClick={() => toggle('upcoming')} aria-expanded={open}>
        <span className="bundle-ico"><Icon name={iconOf(top)} size={18} /></span>
        <span className="bundle-title">
          <span>Upcoming <small className="group-count">{items.length}</small></span>
          <small>{shortLine(top)}{items.length > 1 ? ` +${items.length - 1}` : ''}</small>
        </span>
        {today > 0 && <span className="pill">{today} today</span>}
        <Icon name="chevronDown" size={18} className="bundle-chev" />
      </button>
      {open && (
        <div className="upcoming-list">
          {items.map((it) => (
            <UpcomingRow key={`${it.threadId}-${it.messageId}`} item={it} onOpen={onOpen} onHide={() => void hide(it)} />
          ))}
          <div className="upcoming-tip">Swipe right to remove an item</div>
        </div>
      )}
    </section>
  );
}

const iconOf = (c: SmartCard): IconName => (c.kind === 'package' ? 'shipping' : tripIcon(c));
const todayLocal = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
function isToday(c: SmartCard): boolean {
  if (c.kind === 'trip') return c.depart.slice(0, 10) === todayLocal();
  return c.status === 'out_for_delivery' || (c.status !== 'delivered' && c.expected === todayLocal());
}
/** What matters most first: today's deliveries and trips, then by date; delivered last. */
function urgency(c: SmartCard): number {
  if (c.kind === 'package' && c.status === 'delivered') return 9e12;
  if (isToday(c)) return 0;
  const day = c.kind === 'trip' ? c.depart : c.expected;
  return day ? Date.parse(`${day.slice(0, 10)}T12:00:00Z`) : 8e12;
}
/** The one line shown while closed: "Smart LED bulb · out for delivery today", "Train to Milano · tomorrow, 10:05". */
function shortLine(c: SmartCard): string {
  if (c.kind === 'package') return `${c.title} · ${packageLine(c).toLowerCase()}`;
  const mode = c.mode === 'flight' ? 'Flight' : c.mode === 'bus' ? 'Bus' : 'Train';
  return `${mode} to ${c.to} · ${whenLabel(c.depart).replace(/^./, (x) => x.toLowerCase())}`;
}

/** One parcel or trip in the open Upcoming list. Swipe right (or the × on a computer) removes it. */
function UpcomingRow({ item, onOpen, onHide }: { item: UpcomingItem; onOpen: (threadId: string) => void; onHide: () => void }) {
  const c = item.card;
  const [dx, setDx] = useState(0);
  const [leaving, setLeaving] = useState(false);
  const drag = useRef<{ x: number; y: number; on: boolean; moved: boolean } | null>(null);
  const title = c.kind === 'package' ? c.title : `${c.from} → ${c.to}`;
  const line = c.kind === 'package' ? `${packageLine(c)}${c.merchant ? ` · ${c.merchant}` : ''}` : `${whenLabel(c.depart)}${c.number ? ` · ${c.number}` : ''}`;
  const down = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    drag.current = { x: e.clientX, y: e.clientY, on: false, moved: false };
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const mx = e.clientX - d.x;
    const my = e.clientY - d.y;
    if (!d.on) {
      if (Math.abs(my) > 10) { drag.current = null; return; } // scrolling, not swiping
      if (mx > 10) { d.on = true; (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
      else return;
    }
    d.moved = true;
    setDx(Math.max(0, mx));
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d?.on) return;
    const width = (e.currentTarget as HTMLElement).offsetWidth;
    if (dx > Math.min(110, width * 0.3)) {
      setLeaving(true);
      setDx(width);
      window.setTimeout(onHide, 180);
    } else setDx(0);
  };
  return (
    <div className={`upcoming-swipe${leaving ? ' leaving' : ''}`}>
      <div className="upcoming-swipe-bg" style={{ opacity: Math.min(1, dx / 110) }}>
        <Icon name="check" size={20} />
        Remove
      </div>
      <div
        className={`upcoming-item${dx ? ' dragging' : ''}`}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        role="button"
        tabIndex={0}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => { drag.current = null; setDx(0); }}
        onClick={() => { if (!dx) onOpen(item.threadId); }}
        onKeyDown={(e) => e.key === 'Enter' && onOpen(item.threadId)}
      >
        <span className={`upcoming-icon${c.kind === 'package' && c.status === 'delivered' ? ' done' : ''}`}><Icon name={iconOf(c)} size={20} /></span>
        <span className="upcoming-text">
          <b>{title}</b>
          <span>{line}</span>
        </span>
        {c.kind === 'package' && c.trackingUrl && c.status !== 'delivered' && (
          <button type="button" className="smart-btn" onClick={openLink(c.trackingUrl)}>Track</button>
        )}
        <button type="button" className="ib upcoming-x" aria-label="Remove from Upcoming" title="Remove from Upcoming" onClick={(e) => { e.stopPropagation(); onHide(); }}>
          <Icon name="x" size={18} />
        </button>
      </div>
    </div>
  );
}
