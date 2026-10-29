import { describe, it, expect } from 'vitest';
import { parseIcs, googleCalendarLink } from './ics.js';
import { parseQuery } from '../search.js';

const ICS = `BEGIN:VCALENDAR
METHOD:REQUEST
BEGIN:VEVENT
UID:abc@example.com
SUMMARY:Riprese ISUZU \\, giorno 1
DTSTART;TZID=Europe/Rome:20261104T090000
DTEND;TZID=Europe/Rome:20261104T180000
LOCATION:Via Emilia 10\\, Modena
DESCRIPTION:Portare il drone.\\nArrivo alle 8:30.
ORGANIZER;CN=Anna Vialetto:mailto:anna.v@netstrategy.it
ATTENDEE;CN=Emanuele;PARTSTAT=NEEDS-ACTION:mailto:info@stostudio.it
END:VEVENT
END:VCALENDAR`;

describe('ics', () => {
  it('parses an invitation with a time zone', () => {
    const ev = parseIcs(ICS);
    expect(ev).not.toBeNull();
    expect(ev!.method).toBe('REQUEST');
    expect(ev!.summary).toBe('Riprese ISUZU , giorno 1');
    expect(ev!.location).toBe('Via Emilia 10, Modena');
    expect(ev!.start).toBe('2026-11-04T08:00:00.000Z'); // 09:00 Rome (CET) = 08:00 UTC
    expect(ev!.organizer?.email).toBe('anna.v@netstrategy.it');
    expect(ev!.attendees[0].status).toBe('NEEDS-ACTION');
    const link = googleCalendarLink(ev!)!;
    expect(link).toContain('dates=20261104T080000Z%2F20261104T170000Z');
    expect(link).toContain('text=Riprese+ISUZU');
  });
  it('handles all-day events', () => {
    const ev = parseIcs('BEGIN:VCALENDAR\nBEGIN:VEVENT\nSUMMARY:Fiera\nDTSTART;VALUE=DATE:20261201\nDTEND;VALUE=DATE:20261202\nEND:VEVENT\nEND:VCALENDAR');
    expect(ev!.allDay).toBe(true);
    expect(googleCalendarLink(ev!)).toContain('dates=20261201%2F20261202');
  });
});

describe('search size/age operators', () => {
  it('parses larger/smaller/older_than', () => {
    const p = parseQuery('larger:2M smaller:10mb older_than:3m');
    expect(p.larger).toBe(2 * 1024 * 1024);
    expect(p.smaller).toBe(10 * 1024 * 1024);
    expect(p.olderThanDays).toBe(90);
  });
});
