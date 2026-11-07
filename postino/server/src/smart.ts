import type { FastifyInstance } from 'fastify';
import { db } from './db.js';
import { log } from './log.js';

/**
 * Gmail-style cards for packages and trips, without any AI.
 *
 * 1. Senders that mark up their mail for Gmail (schema.org JSON-LD: ParcelDelivery, Order,
 *    TrainReservation, FlightReservation, BusReservation) are read exactly as Gmail reads them.
 * 2. Otherwise fixed rules for the formats people actually get (Amazon order updates, Trenitalia
 *    tickets) and a generic shipping rule (status words, a tracking link, a delivery date).
 *
 * One row per message in smart_items (kind 'none' marks "looked, nothing found"). The list shows a
 * chip on the row, the reader a card, and the inbox an "Upcoming" block with parcels on their way
 * and trips in the next weeks.
 */

db.exec(`CREATE TABLE IF NOT EXISTS smart_items (
  message_row INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  event_at TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'rules',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`);
db.exec('CREATE INDEX IF NOT EXISTS smart_items_thread ON smart_items(thread_id)');
// Parcels and trips swiped away from Upcoming (by item key, so later updates of it stay hidden).
db.exec(`CREATE TABLE IF NOT EXISTS smart_hidden (item_key TEXT PRIMARY KEY, hidden_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
db.exec('CREATE INDEX IF NOT EXISTS smart_items_kind ON smart_items(kind, event_at)');

export type PackageStatus = 'ordered' | 'shipped' | 'out_for_delivery' | 'delivered' | 'problem' | '';
export type SmartCard =
  | {
      kind: 'package';
      title: string; // what is coming
      merchant: string;
      status: PackageStatus;
      expected: string; // YYYY-MM-DD, '' when unknown
      carrier: string;
      trackingNumber: string;
      trackingUrl: string;
      orderId: string;
    }
  | {
      kind: 'trip';
      mode: 'train' | 'flight' | 'bus';
      operator: string;
      number: string; // "Regionale Veloce 3979", "AZ 1234"
      from: string;
      to: string;
      depart: string; // YYYY-MM-DDTHH:MM, local time as printed on the ticket
      arrive: string;
      bookingRef: string;
      seat: string;
    };

export type MailInput = { fromEmail: string; fromName: string; subject: string; text: string; html: string; rawHtml?: string | null; date: string };

// ---------------------------------------------------------------- dates

const TZ = 'Europe/Rome';
/** The calendar day of an instant in Italy, as YYYY-MM-DD. */
export function localDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function addDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domenica: 0, lunedi: 1, 'lunedì': 1, martedi: 2, 'martedì': 2, mercoledi: 3, 'mercoledì': 3, giovedi: 4, 'giovedì': 4, venerdi: 5, 'venerdì': 5, sabato: 6,
};
const MONTHS: Record<string, number> = {
  jan: 1, january: 1, gen: 1, gennaio: 1, feb: 2, february: 2, febbraio: 2, mar: 3, march: 3, marzo: 3, apr: 4, april: 4, aprile: 4, may: 5, mag: 5, maggio: 5,
  jun: 6, june: 6, giu: 6, giugno: 6, jul: 7, july: 7, lug: 7, luglio: 7, aug: 8, august: 8, ago: 8, agosto: 8, sep: 9, sept: 9, september: 9, set: 9, settembre: 9,
  oct: 10, october: 10, ott: 10, ottobre: 10, nov: 11, november: 11, novembre: 11, dec: 12, december: 12, dic: 12, dicembre: 12,
};

/**
 * A delivery day written in words, relative to when the email was sent: "today", "tomorrow",
 * "Tuesday", "10 November", "mar 10 nov", "10/11/2026". Returns YYYY-MM-DD or ''.
 */
export function parseDay(phrase: string, sentAt: Date): string {
  const p = phrase.toLowerCase().normalize('NFC');
  const base = localDay(sentAt);
  if (/\b(today|oggi)\b/.test(p)) return base;
  if (/\b(tomorrow|domani)\b/.test(p)) return addDays(base, 1);
  let m = p.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
  if (m) {
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(base.slice(0, 4));
    const day = `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    return /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(day) ? rollYear(day, base) : '';
  }
  m = p.match(/\b(\d{1,2})\s+([a-zà-ù]{3,9})\.?(?:\s+(\d{4}))?/) || null;
  const m2 = p.match(/\b([a-zà-ù]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/);
  const pick = m && MONTHS[m[2]] ? { d: Number(m[1]), mo: MONTHS[m[2]], y: m[3] } : m2 && MONTHS[m2[1]] ? { d: Number(m2[2]), mo: MONTHS[m2[1]], y: m2[3] } : null;
  if (pick && pick.d >= 1 && pick.d <= 31) {
    const y = pick.y ? Number(pick.y) : Number(base.slice(0, 4));
    return rollYear(`${y}-${String(pick.mo).padStart(2, '0')}-${String(pick.d).padStart(2, '0')}`, base);
  }
  for (const [name, wd] of Object.entries(WEEKDAYS)) {
    if (new RegExp(`\\b${name}\\b`).test(p)) {
      const today = new Date(`${base}T12:00:00Z`).getUTCDay();
      const ahead = (wd - today + 7) % 7 || 7; // "Tuesday" on a Tuesday means next week
      return addDays(base, ahead);
    }
  }
  return '';
}
/** "10 Jan" written in late December is next year's. */
function rollYear(day: string, base: string): string {
  if (day < addDays(base, -60)) return `${Number(day.slice(0, 4)) + 1}${day.slice(4)}`;
  return day;
}

// ---------------------------------------------------------------- links

function linksOf(html: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 200) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    out.push({ text, href: m[1].replace(/&amp;/g, '&') });
  }
  return out;
}

const CARRIERS: [RegExp, string][] = [
  [/\bbrt\b|bartolini/i, 'BRT'], [/\bgls\b/i, 'GLS'], [/\bdhl\b/i, 'DHL'], [/\bups\b/i, 'UPS'], [/fedex/i, 'FedEx'], [/\btnt\b/i, 'TNT'],
  [/\bsda\b/i, 'SDA'], [/poste ?italiane|poste\.it/i, 'Poste Italiane'], [/inpost/i, 'InPost'], [/\bdpd\b/i, 'DPD'], [/nexive/i, 'Nexive'],
  [/milkman/i, 'Milkman'], [/mondial ?relay/i, 'Mondial Relay'], [/cainiao/i, 'Cainiao'], [/hermes|evri/i, 'Evri'], [/royal ?mail/i, 'Royal Mail'],
];
const CARRIER_HOSTS = /(^|\.)(brt\.it|gls-italy\.com|gls-group\.(eu|com)|dhl\.(com|it|de)|ups\.com|fedex\.com|tnt\.(it|com)|sda\.it|poste\.it|inpost\.(it|pl|eu)|dpd\.(com|it|de)|nexive\.it|milkmantechnologies\.com|mondialrelay\.(it|fr|com)|cainiao\.com|global\.cainiao\.com|evri\.com|royalmail\.com|17track\.net|parcelsapp\.com|aftership\.com|amazon\.[a-z.]+|track\.amazon\.[a-z.]+|vinted\.[a-z.]+|aliexpress\.[a-z.]+|ebay\.[a-z.]+|zalando\.[a-z.]+|packlink\.(it|com))$/i;

/** The registrable part of a host: shop.example.co.uk -> example.co.uk. */
function baseHost(host: string): string {
  const l = host.toLowerCase().split('.');
  const two = l.length > 2 && /^(co|com|org|net)$/.test(l[l.length - 2]) && l[l.length - 1].length === 2;
  return l.slice(two ? -3 : -2).join('.');
}
/** A tracking link is shown only if it goes to the sender's own site or to a known carrier. */
function safeTrackingUrl(href: string, fromEmail: string): string {
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    const senderBase = baseHost(fromEmail.split('@')[1] || '');
    if (baseHost(u.hostname) === senderBase || CARRIER_HOSTS.test(u.hostname)) return u.toString();
  } catch {
    /* not a URL */
  }
  return '';
}

// ---------------------------------------------------------------- 1. schema.org markup

type Node = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : v && typeof v === 'object' && 'name' in (v as Node) ? str((v as Node).name) : '');
const typeOf = (n: Node): string => {
  const t = n['@type'];
  return (Array.isArray(t) ? String(t[0]) : String(t || '')).replace(/^https?:\/\/schema\.org\//, '');
};

function nodesOf(rawHtml: string): Node[] {
  const out: Node[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawHtml))) {
    try {
      const v = JSON.parse(m[1].replace(/&quot;/g, '"').trim()) as unknown;
      const walk = (x: unknown) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === 'object') {
          const n = x as Node;
          if (n['@graph']) walk(n['@graph']);
          if (n['@type']) out.push(n);
        }
      };
      walk(v);
    } catch {
      /* broken markup: ignore */
    }
  }
  return out;
}

/** Local time as written: "2026-11-06T15:09:00+01:00" -> "2026-11-06T15:09". */
const localTime = (iso: string): string => (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16) : '');

export function fromMarkup(rawHtml: string, fromEmail: string, sentAt: Date): SmartCard | null {
  for (const n of nodesOf(rawHtml)) {
    const t = typeOf(n);
    if (t === 'ParcelDelivery' || t === 'Order') {
      const delivery = (t === 'ParcelDelivery' ? n : (n.orderDelivery as Node) || n) as Node;
      const order = (t === 'Order' ? n : (delivery.partOfOrder as Node) || {}) as Node;
      const items = (delivery.itemShipped || (order.acceptedOffer as Node)?.itemOffered || (Array.isArray(order.acceptedOffer) ? (order.acceptedOffer[0] as Node)?.itemOffered : null)) as unknown;
      const title = Array.isArray(items) ? str(items[0]) + (items.length > 1 ? ` and ${items.length - 1} more` : '') : str(items);
      const statusText = `${str(order.orderStatus)} ${str(delivery.deliveryStatus)}`.toLowerCase();
      const status: PackageStatus = /delivered/.test(statusText) ? 'delivered' : /problem|returned|cancel/.test(statusText) ? 'problem' : /transit|shipped|outfordelivery/.test(statusText) ? (/outfordelivery/.test(statusText) ? 'out_for_delivery' : 'shipped') : t === 'ParcelDelivery' ? 'shipped' : 'ordered';
      const until = str(delivery.expectedArrivalUntil) || str(delivery.expectedArrivalFrom);
      const trackAction = (Array.isArray(n.potentialAction) ? n.potentialAction : [n.potentialAction]).find((a) => a && typeOf(a as Node) === 'TrackAction') as Node | undefined;
      return {
        kind: 'package',
        title: title || str(order.description) || 'Your order',
        merchant: str(order.merchant) || str(order.seller),
        status,
        expected: /^\d{4}-\d{2}-\d{2}/.test(until) ? until.slice(0, 10) : until ? parseDay(until, sentAt) : '',
        carrier: str(delivery.carrier) || str(delivery.provider),
        trackingNumber: str(delivery.trackingNumber),
        trackingUrl: safeTrackingUrl(str(delivery.trackingUrl) || str(trackAction?.target) || str(trackAction?.url), fromEmail),
        orderId: str(order.orderNumber),
      };
    }
    if (t === 'TrainReservation' || t === 'FlightReservation' || t === 'BusReservation') {
      if (/cancel/i.test(str(n.reservationStatus))) continue;
      const trip = (Array.isArray(n.reservationFor) ? n.reservationFor[0] : n.reservationFor) as Node | undefined;
      if (!trip) continue;
      const mode = t === 'TrainReservation' ? 'train' : t === 'FlightReservation' ? 'flight' : 'bus';
      const place = (k: string) => {
        const v = trip[k] as Node | undefined;
        return v ? str(v.name) || str(v.iataCode) : '';
      };
      const seat = ((n.reservedTicket as Node)?.ticketedSeat as Node) || {};
      return {
        kind: 'trip',
        mode,
        operator: str(trip.trainCompany) || str(trip.airline) || str(trip.busCompany) || str(trip.provider),
        number: [str(trip.trainName), str((trip.airline as Node)?.iataCode) + str(trip.flightNumber) || str(trip.trainNumber) || str(trip.busNumber)].filter(Boolean).join(' '),
        from: place('departureStation') || place('departureAirport') || place('departureBusStop'),
        to: place('arrivalStation') || place('arrivalAirport') || place('arrivalBusStop'),
        depart: localTime(str(trip.departureTime)),
        arrive: localTime(str(trip.arrivalTime)),
        bookingRef: str(n.reservationNumber),
        seat: [str(seat.seatingType), str(seat.seatSection) && `coach ${str(seat.seatSection)}`, str(seat.seatNumber) && `seat ${str(seat.seatNumber)}`].filter(Boolean).join(', '),
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------- 2. fixed rules

const AMAZON_STATUS: [RegExp, PackageStatus][] = [
  [/^(ordered|ordinato|ordine effettuato)\b/i, 'ordered'],
  [/^(dispatched|shipped|spedito|spedizione)\b/i, 'shipped'],
  [/^(out for delivery|in consegna)\b/i, 'out_for_delivery'],
  [/^(delivered|consegnato)\b/i, 'delivered'],
];

function amazon(m: MailInput, sentAt: Date): SmartCard | null {
  if (!/@([a-z0-9-]+\.)*amazon\.[a-z.]+$/i.test(m.fromEmail)) return null;
  const status = AMAZON_STATUS.find(([re]) => re.test(m.subject))?.[1];
  if (!status) return null;
  const quoted = m.subject.match(/[‘'"“](.+?)(?:\.\.\.|…)?[’'"”]/);
  const more = m.subject.match(/and (\d+) more items?|e (?:altri )?(\d+) (?:altri )?articol/i);
  let title = quoted ? quoted[1].replace(/\.\.\.$|…$/, '').trim() : m.subject.split(':').slice(1).join(':').trim();
  if (more) title += ` + ${more[1] || more[2]} more`;
  const arriving = m.text.match(/(?:arriving|arrivo previsto|arriverà|consegna prevista(?: entro)?|in arrivo)\s*:?\s*([^\n]{2,40})/i);
  const order = m.text.match(/\b\d{3}-\d{7}-\d{7}\b/);
  const link = linksOf(m.html).find((l) => /track package|traccia (il )?pacco|traccia spedizione|segui il pacco/i.test(l.text) || /progress-tracker/.test(l.href));
  let trackingUrl = link ? safeTrackingUrl(link.href, m.fromEmail) : '';
  if (!trackingUrl) {
    const u = m.text.match(/https:\/\/www\.amazon\.[a-z.]+\/progress-tracker\/package[^\s)>"]+/);
    if (u) trackingUrl = safeTrackingUrl(u[0], m.fromEmail);
  }
  return {
    kind: 'package',
    title,
    merchant: 'Amazon',
    status,
    expected: status === 'delivered' ? localDay(sentAt) : status === 'out_for_delivery' ? localDay(sentAt) : arriving ? parseDay(arriving[1], sentAt) : '',
    carrier: '',
    trackingNumber: '',
    trackingUrl: status === 'ordered' ? '' : trackingUrl,
    orderId: order ? order[0] : '',
  };
}

const TRAIN_KINDS = 'Frecciarossa|Frecciargento|Frecciabianca|Intercity Notte|Intercity|Regionale Veloce|Regionale TTPER|Regionale|Eurocity|Euronight|Italo|Leonardo Express|Railjet|TGV|ICE';
/** Trenitalia (and similar) confirmations: "Regionale Veloce 3979 del 06/11/2026\nPadova (15:09) - Bologna Centrale (16:52)". */
function trainTicket(m: MailInput): SmartCard | null {
  const text = m.text.replace(/\r/g, '');
  const head = text.match(new RegExp(`\\b(${TRAIN_KINDS})\\s+(\\d{2,5})\\s+del\\s+(\\d{2})/(\\d{2})/(\\d{4})`, 'i'));
  const route = text.match(/^\s*([A-ZÀ-Ü][^\n()]{1,60}?)\s*\((\d{1,2})[:.](\d{2})\)\s*[-–→]\s*([A-ZÀ-Ü][^\n()]{1,60}?)\s*\((\d{1,2})[:.](\d{2})\)/m);
  if (!head || !route) return null;
  const day = `${head[5]}-${head[4]}-${head[3]}`;
  const hhmm = (h: string, mm: string) => `${h.padStart(2, '0')}:${mm}`;
  const dep = `${day}T${hhmm(route[2], route[3])}`;
  let arrDay = day;
  if (hhmm(route[5], route[6]) < hhmm(route[2], route[3])) arrDay = addDays(day, 1);
  const code = text.match(/Codice Biglietto\s*:?\s*([A-Z0-9]{5,})/i) || text.match(/\bPNR\s*:?\s*([A-Z0-9]{5,8})\b/i);
  const cp = text.match(/Codice Cambio Prenotazione\s*\(CP\)\s*:?\s*([A-Z0-9]{4,})/i);
  const seat = text.match(/Carrozza\s*(\d+)[^\n]{0,20}?Posto\s*(\w+)/i);
  return {
    kind: 'trip',
    mode: 'train',
    operator: /@trenitalia\.it$/i.test(m.fromEmail) ? 'Trenitalia' : /italo/i.test(m.fromEmail) ? 'Italo' : '',
    number: `${head[1]} ${head[2]}`,
    from: route[1].trim(),
    to: route[4].trim(),
    depart: dep,
    arrive: `${arrDay}T${hhmm(route[5], route[6])}`,
    bookingRef: [code ? code[1] : '', cp ? `CP ${cp[1]}` : ''].filter(Boolean).join(' · '),
    seat: seat ? `coach ${seat[1]}, seat ${seat[2]}` : '',
  };
}

const SHIP_SUBJECT = /(spedit[oaie]|spedizione|è in viaggio|in transito|shipped|dispatched|on (its|the) way|out for delivery|in consegna|consegnat[oa]|delivered|pacco|parcel|package|tracking|traccia)/i;
const PROMO = /(%|sconto|discount|offert|\bsale\b|saldi|coupon|codice promo|newsletter|black friday|gratis|free shipping on)/i;
/** Any other shop or carrier: status words in the subject, a tracking link, maybe a date. */
function genericParcel(m: MailInput, sentAt: Date): SmartCard | null {
  if (!SHIP_SUBJECT.test(m.subject) || PROMO.test(m.subject)) return null;
  const links = linksOf(m.html);
  const track = links.find((l) => /track|traccia|segui|monitora|stato (della )?spedizione|where is my/i.test(l.text) && safeTrackingUrl(l.href, m.fromEmail));
  const words = `${m.subject}\n${m.text.slice(0, 4000)}`;
  const number = words.match(/(?:tracking(?: number| code| no\.?)?|numero (?:di )?(?:spedizione|tracking|tracciamento)|codice (?:di )?(?:spedizione|tracciamento)|LDV|lettera di vettura)\s*[:#]?\s*([A-Z0-9]{8,30})\b/i);
  if (!track && !number) return null; // just a word in a subject is not enough
  const status: PackageStatus = /consegnat[oa]|delivered|è stato consegnato/i.test(m.subject) ? 'delivered' : /out for delivery|in consegna/i.test(m.subject) ? 'out_for_delivery' : /problem|non riuscit|failed|giacenza|tentata/i.test(m.subject) ? 'problem' : 'shipped';
  const when = words.match(/(?:consegna prevista|data di consegna prevista|arriverà|arriving|expected(?: delivery)?|estimated delivery|delivery (?:date|by)|entro il)\s*:?\s*([^\n]{2,40})/i);
  const carrier = CARRIERS.find(([re]) => re.test(words))?.[1] || '';
  const item = m.subject.match(/[‘'"“]([^’'"”]{3,80})[’'"”]/);
  return {
    kind: 'package',
    title: item ? item[1] : m.fromName || m.fromEmail.split('@')[1] || 'Your parcel',
    merchant: m.fromName,
    status,
    expected: status === 'delivered' ? localDay(sentAt) : when ? parseDay(when[1], sentAt) : '',
    carrier,
    trackingNumber: number ? number[1] : '',
    trackingUrl: track ? safeTrackingUrl(track.href, m.fromEmail) : '',
    orderId: '',
  };
}

/** Everything the rules can tell about one email, or null. Pure: no database. */
export function cardFor(m: MailInput): SmartCard | null {
  const sentAt = new Date(m.date);
  if (m.rawHtml) {
    const c = fromMarkup(m.rawHtml, m.fromEmail, sentAt);
    if (c) return c;
  }
  return amazon(m, sentAt) || trainTicket(m) || genericParcel(m, sentAt);
}

// ---------------------------------------------------------------- storage

function keyOf(c: SmartCard, threadId: number): string {
  if (c.kind === 'trip') return `trip|${c.number}|${c.depart}`;
  // Amazon sends one thread per update; the same order and item ties them together.
  return c.orderId ? `pkg|${c.orderId}|${c.title.toLowerCase().slice(0, 24)}` : c.trackingNumber ? `pkg|${c.trackingNumber}` : `pkg|thread|${threadId}`;
}

/** Look at one stored message (after its body arrives). rawHtml only when it was just downloaded. */
export function noteMessage(messageRow: number, rawHtml?: string | null): void {
  try {
    const m = db
      .prepare(`SELECT m.id, m.thread_id, m.subject, m.from_json, m.from_email, m.date, m.mine, b.text, b.html FROM messages m LEFT JOIN bodies b ON b.message_row = m.id WHERE m.id = ?`)
      .get(messageRow) as { id: number; thread_id: number; subject: string; from_json: string; from_email: string; date: string; mine: number; text: string | null; html: string | null } | undefined;
    if (!m || m.mine) return;
    let fromName = '';
    try {
      fromName = (JSON.parse(m.from_json) as { name?: string }).name || '';
    } catch {
      /* keep empty */
    }
    const c = cardFor({ fromEmail: m.from_email, fromName, subject: m.subject, text: m.text || '', html: m.html || '', rawHtml, date: m.date });
    const eventAt = !c ? null : c.kind === 'trip' ? c.depart || null : c.expected || null;
    db.prepare(
      `INSERT INTO smart_items(message_row, thread_id, kind, item_key, status, event_at, data_json, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(message_row) DO UPDATE SET thread_id = excluded.thread_id, kind = excluded.kind, item_key = excluded.item_key, status = excluded.status, event_at = excluded.event_at, data_json = excluded.data_json, source = excluded.source`,
    ).run(m.id, m.thread_id, c ? c.kind : 'none', c ? keyOf(c, m.thread_id) : '', c && c.kind === 'package' ? c.status : '', eventAt, c ? JSON.stringify(c) : '{}', rawHtml && c ? 'markup-or-rules' : 'rules');
  } catch (err) {
    log.warn({ err: (err as Error).message, messageRow }, 'smart card failed');
  }
}

/** The card of a conversation's newest message that has one. */
export function threadCard(threadId: number): (SmartCard & { messageId: string }) | null {
  const r = db
    .prepare(`SELECT s.message_row, s.data_json FROM smart_items s JOIN messages m ON m.id = s.message_row WHERE s.thread_id = ? AND s.kind <> 'none' ORDER BY m.date DESC LIMIT 1`)
    .get(threadId) as { message_row: number; data_json: string } | undefined;
  return r ? { ...(JSON.parse(r.data_json) as SmartCard), messageId: String(r.message_row) } : null;
}

export function messageCard(messageRow: number): SmartCard | null {
  const r = db.prepare(`SELECT data_json FROM smart_items WHERE message_row = ? AND kind <> 'none'`).get(messageRow) as { data_json: string } | undefined;
  return r ? (JSON.parse(r.data_json) as SmartCard) : null;
}

/** Parcels on their way and trips coming up, for the top of the inbox. */
export function upcoming(now = new Date()) {
  const today = localDay(now);
  const rows = db
    .prepare(
      `SELECT s.message_row, s.thread_id, s.kind, s.item_key, s.status, s.event_at, s.data_json, m.date
       FROM smart_items s JOIN messages m ON m.id = s.message_row JOIN folders f ON f.id = m.folder_id
       WHERE s.kind IN ('package', 'trip') AND m.date >= ? AND f.role NOT IN ('trash', 'junk', 'blocked')
       ORDER BY m.date DESC`,
    )
    .all(new Date(now.getTime() - 40 * 86_400_000).toISOString()) as { message_row: number; thread_id: number; kind: string; item_key: string; status: string; event_at: string | null; data_json: string; date: string }[];
  const seen = new Set<string>();
  const packages: unknown[] = [];
  const trips: unknown[] = [];
  const hidden = new Set((db.prepare('SELECT item_key FROM smart_hidden').all() as { item_key: string }[]).map((h) => h.item_key));
  for (const r of rows) {
    if (seen.has(r.item_key) || hidden.has(r.item_key)) continue; // newest update of each parcel / trip wins
    seen.add(r.item_key);
    const card = JSON.parse(r.data_json) as SmartCard;
    const item = { threadId: String(r.thread_id), messageId: String(r.message_row), key: r.item_key, card, at: r.date };
    if (card.kind === 'package') {
      if (card.status === 'delivered') {
        if (localDay(new Date(r.date)) === today) packages.push(item); // delivered today: shown until tonight
        continue;
      }
      if (card.status === 'problem' || card.status === 'shipped' || card.status === 'out_for_delivery' || card.status === 'ordered') {
        const stale = card.expected ? card.expected < addDays(today, -2) : r.date < new Date(now.getTime() - 14 * 86_400_000).toISOString();
        if (!stale) packages.push(item);
      }
    } else if (card.kind === 'trip' && card.depart) {
      // Departure is local Italian time; compare as text with the local "now".
      const nowLocal = `${today}T${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now)}`;
      const endLocal = (card.arrive || card.depart) >= nowLocal;
      if (endLocal && card.depart <= `${addDays(today, 30)}T23:59`) trips.push(item);
    }
  }
  const order = (x: { card: SmartCard }) => (x.card.kind === 'trip' ? x.card.depart : x.card.expected || '9999');
  trips.sort((a, b) => (order(a as never) < order(b as never) ? -1 : 1));
  packages.sort((a, b) => (order(a as never) < order(b as never) ? -1 : 1));
  return { packages: packages.slice(0, 8), trips: trips.slice(0, 5) };
}

/** Recent mail that arrived before this feature existed: cards from the stored text. */
export function backfill(days = 45): number {
  const rows = db
    .prepare(
      `SELECT m.id FROM messages m JOIN folders f ON f.id = m.folder_id
       WHERE m.date >= ? AND m.body_fetched = 1 AND m.mine = 0 AND f.role IN ('inbox', 'archive', 'other')
         AND NOT EXISTS (SELECT 1 FROM smart_items s WHERE s.message_row = m.id) LIMIT 5000`,
    )
    .all(new Date(Date.now() - days * 86_400_000).toISOString()) as { id: number }[];
  for (const r of rows) noteMessage(r.id);
  return rows.length;
}

export function hideItem(key: string, hide = true): void {
  if (hide) db.prepare('INSERT OR IGNORE INTO smart_hidden(item_key) VALUES (?)').run(key);
  else db.prepare('DELETE FROM smart_hidden WHERE item_key = ?').run(key);
  // Keys of long-gone parcels are not worth keeping.
  db.prepare("DELETE FROM smart_hidden WHERE hidden_at < strftime('%Y-%m-%dT%H:%M:%fZ','now','-90 days')").run();
}

export function registerSmartRoutes(app: FastifyInstance): void {
  app.get('/api/smart/upcoming', async () => upcoming());
  app.post<{ Body: { key?: string; hidden?: boolean } }>('/api/smart/hide', async (req, reply) => {
    const key = String(req.body?.key || '').slice(0, 300);
    if (!key) return reply.code(400).send({ error: 'bad_key', message: 'Which item?' });
    hideItem(key, req.body?.hidden !== false);
    return { ok: true };
  });
}
