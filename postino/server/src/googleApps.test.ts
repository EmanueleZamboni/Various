import { describe, it, expect } from 'vitest';
import { replyIcs } from './googleApps.js';
import { parseIcs } from './mail/ics.js';

describe('invitation reply', () => {
  it('builds an iMIP REPLY the organiser can match', () => {
    const ev = parseIcs('BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\nUID:abc@google.com\r\nSEQUENCE:2\r\nDTSTART:20261104T093000Z\r\nDTEND:20261104T103000Z\r\nSUMMARY:Call, with; Luca\r\nORGANIZER;CN=Luca:mailto:luca@example.com\r\nATTENDEE;CN=Ema:mailto:info@emazamboni.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n')!;
    const ics = replyIcs(ev, { name: 'Ema', email: 'info@emazamboni.com' }, 'accepted');
    expect(ics).toContain('METHOD:REPLY');
    expect(ics).toContain('UID:abc@google.com');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('DTSTART:20261104T093000Z');
    expect(ics).toContain('ATTENDEE;PARTSTAT=ACCEPTED;CN=Ema:mailto:info@emazamboni.com');
    expect(ics).toContain(String.raw`SUMMARY:Call\, with\; Luca`);
    expect(ics).toContain('ORGANIZER;CN=Luca:mailto:luca@example.com');
  });
});
