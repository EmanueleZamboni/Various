/**
 * Minimal iCalendar reader for invitation mails: enough to show an event card
 * and build an "Add to Google Calendar" link. Not a full RFC 5545 parser.
 */
export type CalendarEvent = {
  method: string; // REQUEST, CANCEL, REPLY, PUBLISH
  summary: string;
  description: string;
  location: string;
  start: string | null; // ISO
  end: string | null;
  allDay: boolean;
  organizer: { name: string; email: string } | null;
  attendees: { name: string; email: string; status: string }[];
  uid: string;
  url: string;
  sequence?: number;
};

function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

function unescape(v: string): string {
  return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

/** "20261104T093000Z", "20261104T093000" (+TZID) or "20261104" → ISO string. */
function parseDate(value: string, params: Record<string, string>): { iso: string | null; allDay: boolean } {
  const v = value.trim();
  const date = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (date) return { iso: new Date(Date.UTC(+date[1], +date[2] - 1, +date[3])).toISOString(), allDay: true };
  const dt = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!dt) return { iso: null, allDay: false };
  const [, y, mo, d, h, mi, s, z] = dt;
  if (z) return { iso: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))).toISOString(), allDay: false };
  const tz = params.TZID;
  if (tz) {
    // Convert a local time in TZID to UTC using Intl (close enough for invitation display).
    try {
      const guess = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)));
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
      const asTz = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
      const offset = asTz - guess.getTime();
      return { iso: new Date(guess.getTime() - offset).toISOString(), allDay: false };
    } catch {
      // unknown zone: fall through as floating time
    }
  }
  return { iso: new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0)).toISOString(), allDay: false };
}

function mailto(v: string): string {
  return v.replace(/^mailto:/i, '').trim().toLowerCase();
}

export function parseIcs(text: string): CalendarEvent | null {
  const lines = unfold(text);
  let method = '';
  let inEvent = false;
  const ev: CalendarEvent = { method: '', summary: '', description: '', location: '', start: null, end: null, allDay: false, organizer: null, attendees: [], uid: '', url: '' };
  let found = false;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const head = line.slice(0, i);
    const value = line.slice(i + 1);
    const [name, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const j = p.indexOf('=');
      if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, '');
    }
    const key = name.toUpperCase();
    if (key === 'METHOD') method = value.trim().toUpperCase();
    if (key === 'BEGIN' && value.trim().toUpperCase() === 'VEVENT') {
      if (found) break; // first event only
      inEvent = true;
      found = true;
      continue;
    }
    if (key === 'END' && value.trim().toUpperCase() === 'VEVENT') {
      inEvent = false;
      continue;
    }
    if (!inEvent) continue;
    switch (key) {
      case 'SUMMARY': ev.summary = unescape(value); break;
      case 'DESCRIPTION': ev.description = unescape(value).slice(0, 4000); break;
      case 'LOCATION': ev.location = unescape(value); break;
      case 'UID': ev.uid = value.trim(); break;
      case 'SEQUENCE': ev.sequence = Number.parseInt(value, 10) || 0; break;
      case 'URL': ev.url = value.trim(); break;
      case 'DTSTART': { const d = parseDate(value, params); ev.start = d.iso; ev.allDay = d.allDay; break; }
      case 'DTEND': ev.end = parseDate(value, params).iso; break;
      case 'ORGANIZER': ev.organizer = { name: params.CN || '', email: mailto(value) }; break;
      case 'ATTENDEE': ev.attendees.push({ name: params.CN || '', email: mailto(value), status: (params.PARTSTAT || '').toUpperCase() }); break;
      default: break;
    }
  }
  if (!found) return null;
  ev.method = method;
  return ev;
}

/** Google Calendar "add event" link for an event. */
export function googleCalendarLink(ev: CalendarEvent): string | null {
  if (!ev.start) return null;
  const fmt = (iso: string, allDay: boolean) => (allDay ? iso.slice(0, 10).replace(/-/g, '') : iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'));
  const end = ev.end || (ev.allDay ? new Date(new Date(ev.start).getTime() + 86400_000).toISOString() : new Date(new Date(ev.start).getTime() + 3600_000).toISOString());
  const u = new URL('https://calendar.google.com/calendar/render');
  u.searchParams.set('action', 'TEMPLATE');
  u.searchParams.set('text', ev.summary || 'Event');
  u.searchParams.set('dates', `${fmt(ev.start, ev.allDay)}/${fmt(end, ev.allDay)}`);
  if (ev.location) u.searchParams.set('location', ev.location);
  if (ev.description) u.searchParams.set('details', ev.description.slice(0, 1500));
  return u.toString();
}
