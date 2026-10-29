import { describe, it, expect } from 'vitest';
import { parseQuery, buildMatch } from './search.js';

describe('parseQuery', () => {
  it('parses operators and free text', () => {
    const p = parseQuery('from:anna subject:"piano riprese" has:attachment is:unread in:archive after:2026-09-01 newer_than:2w fattura -spam "colonna sonora"');
    expect(p.from).toEqual(['anna']);
    expect(p.subject).toEqual(['piano riprese']);
    expect(p.hasAttachment).toBe(true);
    expect(p.unread).toBe(true);
    expect(p.inRole).toBe('archive');
    expect(p.after).toBe('2026-09-01T00:00:00.000Z');
    expect(p.newerThanDays).toBe(14);
    expect(p.terms).toEqual(['fattura']);
    expect(p.excluded).toEqual(['spam']);
    expect(p.phrases).toEqual(['colonna sonora']);
  });

  it('accepts Italian date format and spam alias', () => {
    const p = parseQuery('before:15/11/2026 in:spam');
    expect(p.before).toBe('2026-11-15T00:00:00.000Z');
    expect(p.inRole).toBe('junk');
  });
});

describe('buildMatch', () => {
  it('builds prefix and column queries', () => {
    const m = buildMatch(parseQuery('fatt from:anna -freebeat'));
    expect(m).toBe('("fatt"* AND from_text : ("anna"*)) NOT ("freebeat")');
  });
  it('returns null for operator-only queries', () => {
    expect(buildMatch(parseQuery('is:unread has:attachment'))).toBeNull();
  });
  it('escapes quotes', () => {
    expect(buildMatch(parseQuery('say"hi'))).toBe('"say""hi"*');
  });
});
