import { describe, it, expect, afterAll } from 'vitest';
import { buildApp } from './index.js';
import { db, getSetting, setSetting } from './db.js';
import { importSmsXml, listSms, smsDir } from './sms.js';

// Made-up messages and numbers (the repository is public).
const XML = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<smses count="5">
  <sms protocol="0" address="+393331112222" date="1793000000000" type="1" body="Ciao, ci vediamo alle 8?" contact_name="Marco Rossi" />
  <sms protocol="0" address="3331112222" date="1793000600000" type="2" body="Sì, a dopo &amp; porta la chiavetta" contact_name="(Unknown)" />
  <sms protocol="0" address="CORRIERE" date="1793001200000" type="1" body="Il tuo pacco arriva domani" contact_name="(Unknown)" />
  <sms protocol="0" address="CORRIERE" date="1793001200000" type="1" body="Il tuo pacco arriva domani" contact_name="(Unknown)" />
  <sms protocol="0" address="" date="1793001300000" type="1" body="senza numero" />
  <mms date="1793001400000" msg_box="1" address="+393331112222"></mms>
</smses>`;

describe('text messages', () => {
  const appP = buildApp();
  afterAll(async () => {
    db.exec('DELETE FROM sms');
    await (await appP).close();
  });
  it('reads the way of a message', () => {
    expect([smsDir('1'), smsDir('2'), smsDir('sms_in'), smsDir('sent'), smsDir('x')]).toEqual(['in', 'out', 'in', 'out', null]);
  });
  it('imports an SMS Backup & Restore file once and finds messages by person, sender and words', () => {
    db.exec('DELETE FROM sms');
    expect(importSmsXml(XML)).toEqual({ added: 3, skipped: 2, mms: 1 });
    expect(importSmsXml(XML).added).toBe(0);
    const marco = listSms({ query: 'marco' });
    expect(marco.total).toBe(2); // the sent one has no name but the same number
    expect(marco.sms.map((s) => s.dir)).toEqual(['sent', 'received']);
    expect(marco.sms[0].text).toBe('Sì, a dopo & porta la chiavetta');
    expect(listSms({ query: 'corriere' }).sms[0].text).toBe('Il tuo pacco arriva domani');
    expect(listSms({ text: 'pacco domani' }).total).toBe(1);
    expect(listSms({ query: '333 111 2222', dir: 'in' }).total).toBe(1);
  });
  it('takes live SMS on the calls link, keeps the text out of the "last received" note', async () => {
    const app = await appP;
    let tok = getSetting<string>('calls.token', '');
    if (!tok) {
      tok = 'test-token-sms-0123456789abcd';
      setSetting('calls.token', tok);
    }
    const unfilled = await app.inject({ url: `/hooks/calls/${tok}?number=[sms_number]&type=sms_in&text=x` });
    expect(unfilled.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: `/hooks/calls/${tok}`, payload: { type: 'sms_in', number: '+39 333 999 8888', name: 'Anna', text: 'Arrivo tra 10 minuti' } });
    expect(ok.statusCode).toBe(200);
    expect(listSms({ query: 'anna' }).sms[0]).toMatchObject({ dir: 'received', text: 'Arrivo tra 10 minuti' });
    expect(JSON.stringify(getSetting('sms.lastHook', null))).not.toContain('Arrivo');
    const wrong = await app.inject({ url: `/hooks/calls/nope?type=sms_in&number=1&text=x` });
    expect(wrong.statusCode).toBe(404);
  });
});
