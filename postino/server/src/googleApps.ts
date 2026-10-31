import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting } from './db.js';
import { config } from './config.js';
import { googleApi, googleFeatures, setGoogleConnectedHook } from './google.js';
import type { CalendarEvent } from './mail/ics.js';
import { sendMail } from './mail/send.js';
import type { AccountRow } from './views.js';
import { log } from './log.js';

/**
 * Google Calendar (answer invitations, see clashes), Google Contacts (autocomplete and
 * photos) and Google Tasks (turn an email into a task), all through the one Google
 * connection made in Settings → Google.
 */

const CAL = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const PEOPLE = 'https://people.googleapis.com/v1';
const TASKS = 'https://tasks.googleapis.com/tasks/v1/lists/@default/tasks';

const need = (feature: 'calendar' | 'contacts' | 'tasks') => {
  if (!googleFeatures()[feature]) {
    throw Object.assign(new Error('Connect Google again in Settings → Google to allow Calendar, Contacts and Tasks.'), { statusCode: 409 });
  }
};

// ---------- Calendar ----------

type Response = 'accepted' | 'tentative' | 'declined';
const PARTSTAT: Record<Response, string> = { accepted: 'ACCEPTED', tentative: 'TENTATIVE', declined: 'DECLINED' };
const VERB: Record<Response, string> = { accepted: 'Accepted', tentative: 'Tentatively accepted', declined: 'Declined' };

const icsText = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsName = (v: string) => v.replace(/["\r\n:;]/g, '');
const icsDate = (iso: string, allDay: boolean) => (allDay ? iso.slice(0, 10).replace(/-/g, '') : iso.replace(/[-:]/g, '').replace(/\.\d{3}/, ''));

/** The iMIP reply an organiser's calendar (Google, Outlook, Apple…) understands. */
export function replyIcs(ev: CalendarEvent, me: { name: string; email: string }, response: Response): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//Postino//Mail//EN',
    'VERSION:2.0',
    'METHOD:REPLY',
    'BEGIN:VEVENT',
    `UID:${ev.uid}`,
    `DTSTAMP:${icsDate(new Date().toISOString(), false)}`,
    ev.start ? (ev.allDay ? `DTSTART;VALUE=DATE:${icsDate(ev.start, true)}` : `DTSTART:${icsDate(ev.start, false)}`) : '',
    ev.end ? (ev.allDay ? `DTEND;VALUE=DATE:${icsDate(ev.end, true)}` : `DTEND:${icsDate(ev.end, false)}`) : '',
    `SEQUENCE:${ev.sequence ?? 0}`,
    `SUMMARY:${icsText(ev.summary || 'Event')}`,
    ev.organizer ? `ORGANIZER${ev.organizer.name ? `;CN=${icsName(ev.organizer.name)}` : ''}:mailto:${ev.organizer.email}` : '',
    `ATTENDEE;PARTSTAT=${PARTSTAT[response]}${me.name ? `;CN=${icsName(me.name)}` : ''}:mailto:${me.email}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n') + '\r\n';
}

type Loaded = { msg: { id: number; account_id: number; subject: string; to_json: string; cc_json: string; mine: number }; ev: CalendarEvent; account: AccountRow };

function loadInvite(messageId: number): Loaded {
  const msg = db.prepare('SELECT id, account_id, subject, to_json, cc_json, mine FROM messages WHERE id = ?').get(messageId) as Loaded['msg'] | undefined;
  if (!msg) throw Object.assign(new Error('Message not found.'), { statusCode: 404 });
  const row = db.prepare('SELECT calendar_json FROM bodies WHERE message_row = ?').get(messageId) as { calendar_json: string | null } | undefined;
  let ev: CalendarEvent | null = null;
  try {
    ev = row?.calendar_json ? (JSON.parse(row.calendar_json) as CalendarEvent) : null;
  } catch {
    ev = null;
  }
  if (!ev || !ev.uid) throw Object.assign(new Error('This email has no invitation to answer.'), { statusCode: 400 });
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(msg.account_id) as AccountRow;
  return { msg, ev, account };
}

/** Which of my addresses the invitation was sent to. */
function myAttendee(l: Loaded): { name: string; email: string } {
  const mine = new Set([l.account.email.toLowerCase()]);
  try {
    for (const a of JSON.parse(l.account.aliases || '[]') as string[]) mine.add(String(a).toLowerCase());
  } catch {
    // ignore
  }
  const hit = l.ev.attendees.find((a) => mine.has(a.email.toLowerCase()));
  return { name: hit?.name || l.account.name, email: hit?.email || l.account.email };
}

async function saveToGoogleCalendar(ev: CalendarEvent, me: string, response: Response): Promise<boolean> {
  if (!googleFeatures().calendar || !ev.start) return false;
  const when = (iso: string) => (ev.allDay ? { date: iso.slice(0, 10) } : { dateTime: iso });
  await googleApi(`${CAL}/events/import`, {
    method: 'POST',
    body: JSON.stringify({
      iCalUID: ev.uid,
      summary: ev.summary || 'Event',
      location: ev.location || undefined,
      description: ev.description || undefined,
      start: when(ev.start),
      end: when(ev.end || ev.start),
      organizer: ev.organizer ? { email: ev.organizer.email, displayName: ev.organizer.name || undefined } : undefined,
      attendees: [{ email: me, responseStatus: response, self: true }],
    }),
  });
  return true;
}

// ---------- Contacts ----------

type Person = { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[]; photos?: { url?: string; default?: boolean }[] };

export async function syncGoogleContacts(): Promise<number> {
  if (!googleFeatures().contacts) return 0;
  const people: Person[] = [];
  const pull = async (url: string, key: 'connections' | 'otherContacts') => {
    let token = '';
    for (let page = 0; page < 20; page++) {
      const r = await googleApi<Record<string, unknown>>(`${url}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      people.push(...((r[key] as Person[] | undefined) ?? []));
      token = String(r.nextPageToken || '');
      if (!token) break;
    }
  };
  await pull(`${PEOPLE}/people/me/connections?personFields=names,emailAddresses,photos&pageSize=1000`, 'connections');
  await pull(`${PEOPLE}/otherContacts?readMask=names,emailAddresses,photos&pageSize=1000`, 'otherContacts').catch((err) => log.warn({ err }, 'other contacts not read'));
  const upsert = db.prepare(`INSERT INTO contacts(email, name, count, last_seen, in_google, photo_url) VALUES (?, ?, 0, '', 1, ?)
    ON CONFLICT(email) DO UPDATE SET name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END, in_google = 1, photo_url = COALESCE(excluded.photo_url, contacts.photo_url)`);
  let n = 0;
  db.transaction(() => {
    db.prepare('UPDATE contacts SET in_google = 0').run();
    for (const p of people) {
      const name = (p.names?.[0]?.displayName || '').slice(0, 200);
      const photo = p.photos?.find((x) => x.url && !x.default)?.url;
      const url = photo && /^https:\/\/[a-z0-9-]+\.googleusercontent\.com\//i.test(photo) ? photo : null;
      for (const e of p.emailAddresses ?? []) {
        const email = String(e.value || '').trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
        upsert.run(email, name, url);
        n++;
      }
    }
  })();
  setSetting('google.contactsSync', { at: new Date().toISOString(), count: n });
  log.info({ n }, 'google contacts synced');
  return n;
}

// ---------- Routes ----------

export function registerGoogleAppRoutes(app: FastifyInstance): void {
  // Answer an invitation: tell the organiser (iMIP reply email) and put it in Google Calendar.
  app.post<{ Params: { id: string }; Body: { response?: string } }>('/api/messages/:id/rsvp', async (req, reply) => {
    const response = req.body?.response as Response;
    if (!['accepted', 'tentative', 'declined'].includes(response)) return reply.code(400).send({ error: 'bad_response', message: 'Answer with accepted, tentative or declined.' });
    const l = loadInvite(Number(req.params.id));
    if (l.ev.method !== 'REQUEST') return reply.code(400).send({ error: 'not_invite', message: 'Only invitations can be answered.' });
    const me = myAttendee(l);
    if (l.ev.organizer?.email) {
      await sendMail({
        account: l.account,
        fromAddress: me.email !== l.account.email ? me.email : undefined,
        to: l.ev.organizer.email,
        subject: `${VERB[response]}: ${l.ev.summary || l.msg.subject}`,
        text: `${me.name || me.email} ${response === 'accepted' ? 'accepted' : response === 'declined' ? 'declined' : 'might attend'}: ${l.ev.summary || l.msg.subject}`,
        attachments: [],
        icalEvent: { method: 'REPLY', content: replyIcs(l.ev, me, response) },
      });
    }
    let calendar = false;
    try {
      calendar = await saveToGoogleCalendar(l.ev, me.email, response);
    } catch (err) {
      log.warn({ err }, 'could not save the event to Google Calendar');
    }
    db.prepare('INSERT INTO rsvps(message_row, response) VALUES (?, ?) ON CONFLICT(message_row) DO UPDATE SET response = excluded.response, at = excluded.at').run(l.msg.id, response);
    return { ok: true, response, calendar, organizerTold: Boolean(l.ev.organizer?.email) };
  });

  // Your answer so far and what else is in your calendar at that time.
  app.get<{ Params: { id: string } }>('/api/messages/:id/invite', async (req) => {
    const l = loadInvite(Number(req.params.id));
    const rsvp = (db.prepare('SELECT response FROM rsvps WHERE message_row = ?').get(l.msg.id) as { response: string } | undefined)?.response ?? null;
    const f = googleFeatures();
    let conflicts: { summary: string; start: string | null }[] | null = null;
    if (f.calendar && l.ev.start) {
      try {
        const end = l.ev.end || new Date(Date.parse(l.ev.start) + 3_600_000).toISOString();
        const r = await googleApi<{ items?: { iCalUID?: string; summary?: string; status?: string; transparency?: string; start?: { dateTime?: string; date?: string } }[] }>(
          `${CAL}/events?singleEvents=true&maxResults=10&timeMin=${encodeURIComponent(l.ev.start)}&timeMax=${encodeURIComponent(end)}`,
        );
        conflicts = (r.items ?? [])
          .filter((e) => e.iCalUID !== l.ev.uid && e.status !== 'cancelled' && e.transparency !== 'transparent')
          .map((e) => ({ summary: e.summary || 'Busy', start: e.start?.dateTime || e.start?.date || null }));
      } catch (err) {
        log.warn({ err }, 'calendar lookup failed');
      }
    }
    return { rsvp, calendarConnected: f.calendar, conflicts };
  });

  app.post('/api/google/contacts/sync', async () => {
    need('contacts');
    return { count: await syncGoogleContacts() };
  });

  app.get('/api/google/contacts/status', async () => getSetting<{ at: string; count: number } | null>('google.contactsSync', null));

  // ---- Tasks ----
  app.get('/api/tasks', async () => {
    need('tasks');
    const r = await googleApi<{ items?: { id: string; title?: string; notes?: string; due?: string; status?: string; updated?: string }[] }>(`${TASKS}?showCompleted=false&maxResults=100`);
    return { tasks: (r.items ?? []).map((t) => ({ id: t.id, title: t.title || '', notes: t.notes || '', due: t.due || null })) };
  });

  app.post<{ Body: { title?: string; threadId?: string } }>('/api/tasks', async (req, reply) => {
    need('tasks');
    let title = String(req.body?.title || '').trim().slice(0, 500);
    let notes = '';
    if (req.body?.threadId) {
      const t = db.prepare('SELECT t.id, t.subject_norm, m.subject, m.from_json, m.snippet FROM threads t JOIN messages m ON m.thread_id = t.id WHERE t.id = ? ORDER BY m.date DESC LIMIT 1').get(Number(req.body.threadId)) as
        | { id: number; subject: string; from_json: string; snippet: string }
        | undefined;
      if (!t) return reply.code(404).send({ error: 'not_found', message: 'Conversation not found.' });
      let from = '';
      try {
        const f = JSON.parse(t.from_json) as { name?: string; email?: string };
        from = f.name || f.email || '';
      } catch {
        // ignore
      }
      title = title || t.subject || '(no subject)';
      notes = [from ? `From ${from}` : '', t.snippet, config.baseUrl ? `${config.baseUrl.replace(/\/$/, '')}/inbox/t/${t.id}` : ''].filter(Boolean).join('\n');
    }
    if (!title) return reply.code(400).send({ error: 'empty', message: 'Write what the task is.' });
    const r = await googleApi<{ id: string; title: string }>(TASKS, { method: 'POST', body: JSON.stringify({ title, notes: notes || undefined }) });
    return { id: r.id, title: r.title };
  });

  app.patch<{ Params: { id: string }; Body: { done?: boolean; title?: string } }>('/api/tasks/:id', async (req) => {
    need('tasks');
    const id = encodeURIComponent(req.params.id);
    const patch: Record<string, unknown> = {};
    if (typeof req.body?.done === 'boolean') patch.status = req.body.done ? 'completed' : 'needsAction';
    if (typeof req.body?.title === 'string') patch.title = req.body.title.slice(0, 500);
    await googleApi(`${TASKS}/${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (_req, reply) => {
    need('tasks');
    await googleApi(`${TASKS}/${encodeURIComponent(_req.params.id)}`, { method: 'DELETE' });
    return reply.code(204).send();
  });
}

/** Google Contacts: right after connecting, then once a day. */
export function startGoogleContacts(): void {
  setGoogleConnectedHook(async () => {
    await syncGoogleContacts();
  });
  const tick = async () => {
    if (!googleFeatures().contacts) return;
    const last = getSetting<{ at: string } | null>('google.contactsSync', null);
    if (last?.at && Date.now() - Date.parse(last.at) < 23 * 3_600_000) return;
    await syncGoogleContacts().catch((err) => log.warn({ err }, 'contacts sync failed'));
  };
  setTimeout(() => void tick(), 90_000).unref();
  setInterval(() => void tick(), 3_600_000).unref();
}
