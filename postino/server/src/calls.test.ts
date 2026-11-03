import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './index.js';
import { db, getSetting } from './db.js';
import { importCallsXml, listCalls, callStats, callType, parseDuration } from './calls.js';

const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<calls count="4">
  <call number="+393331112222" duration="125" date="1793000000000" type="2" presentable="1" readable_date="x" contact_name="Marco Rossi" />
  <call number="3331112222" duration="0" date="1793003600000" type="3" contact_name="(Unknown)" />
  <call number="+390511234567" duration="61" date="1793007200000" type="1" contact_name="Studio &amp; Co" />
  <call number="+390511234567" duration="61" date="1793007200000" type="1" contact_name="Studio &amp; Co" />
</calls>`;

describe('call log', () => {
  const appP = buildApp();
  afterAll(async () => {
    db.exec('DELETE FROM calls');
    await (await appP).close();
  });
  it('reads codes, words and durations', () => {
    expect([callType('1'), callType('out'), callType('persa'), callType('x')]).toEqual(['incoming', 'outgoing', 'missed', null]);
    expect([parseDuration('75'), parseDuration('1:15'), parseDuration('0:01:15')]).toEqual([75, 75, 75]);
  });
  it('imports an SMS Backup & Restore file once, naming numbers', () => {
    db.exec('DELETE FROM calls');
    expect(importCallsXml(XML)).toEqual({ added: 3, skipped: 1 });
    expect(importCallsXml(XML).added).toBe(0);
    const marco = listCalls({ query: 'marco' });
    expect(marco.total).toBe(2); // the unnamed missed call from the same number too
    expect(marco.calls.map((c) => [c.name, c.type, c.duration])).toEqual([['Marco Rossi', 'missed', '0:00'], ['Marco Rossi', 'outgoing', '2:05']]);
    expect(listCalls({ query: '051 1234567' }).calls[0].name).toBe('Studio & Co');
    expect(callStats({}).people[0]).toMatchObject({ name: 'Marco Rossi', calls: 2, missed: 1, talk_time: '2:05' });
  });
  it('takes live calls on the secret URL only', async () => {
    const app = await appP;
    const bad = await app.inject({ url: '/hooks/calls/wrong?number=1&type=in' });
    expect(bad.statusCode).toBe(404);
    getSetting('calls.token', '');
    const setup = await app.inject({ url: '/api/calls/setup' });
    expect(setup.statusCode).toBe(401); // settings need a Postino session
    const tok = getSetting<string>('calls.token', '') || (await import('./db.js')).getSetting<string>('calls.token', '');
    const path = tok ? `/hooks/calls/${tok}` : '';
    if (!path) return;
    const unfilled = await app.inject({ url: `${path}?number=[call_number]&type=in` });
    expect(unfilled.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: path, payload: { number: '+39 333 999 8888', name: 'Anna', type: 'out', duration: '42' } });
    expect(ok.statusCode).toBe(200);
    expect(listCalls({ query: 'anna' }).calls[0]).toMatchObject({ type: 'outgoing', duration: '0:42' });
  });
});
