import { describe, it, expect } from 'vitest';
import { normalizeSubject, hasReplyPrefix, parseReferences, pickUnsubscribe, categorize, splitQuoted, type ParsedHeaders } from './parse.js';
import { sanitizeEmailHtml, htmlToText } from './sanitize.js';

const base: ParsedHeaders = { messageId: 'a@b', inReplyTo: '', references: [], subject: 'x', from: { name: 'A', email: 'a@b.com' }, to: [], cc: [], bcc: [], replyTo: [], date: null, listUnsubscribe: null, isBulk: false, autoSubmitted: false };

describe('subjects and ids', () => {
  it('normalizes reply prefixes in several languages', () => {
    expect(normalizeSubject('Re: RE: Fwd: R: I: [Ticket 12] Hello  World')).toBe('hello world');
    expect(hasReplyPrefix('AW: test')).toBe(true);
    expect(hasReplyPrefix('Retro tech')).toBe(false);
  });
  it('parses references', () => {
    expect(parseReferences('<a@x> <b@y>\r\n <c@z>')).toEqual(['a@x', 'b@y', 'c@z']);
  });
  it('prefers https unsubscribe links', () => {
    expect(pickUnsubscribe('<mailto:u@x.com>, <https://x.com/u>')).toBe('https://x.com/u');
    expect(pickUnsubscribe('<mailto:u@x.com>')).toBe('mailto:u@x.com');
  });
});

describe('categorize', () => {
  it('detects newsletters, notifications and people', () => {
    expect(categorize({ ...base, listUnsubscribe: 'https://x', isBulk: true })).toBe('newsletter');
    expect(categorize({ ...base, from: { name: '', email: 'drive-shares-dm-noreply@google.com' } })).toBe('notification');
    expect(categorize({ ...base, from: { name: '', email: 'no-reply@shop.example' } })).toBe('notification');
    expect(categorize({ ...base, from: { name: 'Anna', email: 'anna@netstrategy.it' } })).toBe('person');
    expect(categorize({ ...base, from: { name: 'Anna', email: 'anna@netstrategy.it' } }, 'newsletter')).toBe('newsletter');
  });
});

describe('sanitizeEmailHtml', () => {
  it('strips scripts, parks remote images and rewrites cid', () => {
    const cid = new Map([['img1', '/api/attachments/5?inline=1']]);
    const r = sanitizeEmailHtml('<p onclick="x()">Hi <script>evil()</script><img src="https://t.example/p.gif"><img src="cid:img1"><a href="javascript:alert(1)">x</a><a href="https://ok.example">ok</a></p>', cid);
    expect(r.hasRemoteImages).toBe(true);
    expect(r.html).not.toContain('script');
    expect(r.html).not.toContain('onclick');
    expect(r.html).toContain('data-remote-src="https://t.example/p.gif"');
    expect(r.html).toContain('src="/api/attachments/5?inline=1"');
    expect(r.html).not.toContain('javascript:');
    expect(r.html).toContain('target="_blank"');
    expect(r.html).toContain('rel="noopener noreferrer nofollow"');
  });
  it('converts html to text for snippets', () => {
    expect(htmlToText('<div>Ciao<br>a <b>tutti</b>&nbsp;&amp; co</div>')).toBe('Ciao\na tutti & co');
  });
});

describe('splitQuoted', () => {
  it('separates the reply from the quoted part', () => {
    const r = splitQuoted('Ottimo, grazie!\n\nOn Wed, Emanuele wrote:\n> Perfetto Anna\n> Porto il drone');
    expect(r.visible).toBe('Ottimo, grazie!');
    expect(r.quoted).toContain('Perfetto Anna');
  });
});
