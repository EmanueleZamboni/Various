import { describe, it, expect, vi, beforeEach } from 'vitest';

// A fake Claude that records requests and answers with what the test queues.
const calls: { model: string; user: string; fallbacks: unknown }[] = [];
const answers: unknown[] = [];
vi.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {
    status?: number;
  }
  class Anthropic {
    static APIError = APIError;
    static AuthenticationError = class extends APIError {};
    static PermissionDeniedError = class extends APIError {};
    static RateLimitError = class extends APIError {};
    static BadRequestError = class extends APIError {};
    static APIConnectionError = class extends APIError {};
    beta = {
      messages: {
        parse: async (req: { model: string; messages: { content: string }[]; fallbacks?: unknown }) => {
          calls.push({ model: req.model, user: req.messages[0].content, fallbacks: req.fallbacks });
          return { stop_reason: 'end_turn', parsed_output: answers.shift(), usage: { input_tokens: 1500, output_tokens: 200 } };
        },
      },
    };
    models = { retrieve: async () => ({}) };
  }
  return { default: Anthropic };
});

const { db, setSetting, getSetting } = await import('./db.js');
const { encrypt } = await import('./crypto.js');
const { considerMessage, setTriageSettings } = await import('./triage.js');
const { groupedInboxThreads, refreshGroupThreads } = await import('./groups.js');
const { threadView } = await import('./views.js');

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function mail(id: number, from: string, subject: string, text: string, category = 'person', date = new Date().toISOString()) {
  db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, inbox_date, roles, msg_count, unread_count) VALUES (?, 95, ?, ?, ?, ?, ',inbox,', 1, 1)").run(id, subject, subject, date, date);
  db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_json, from_email, date, size, category, body_fetched) VALUES (?, 95, 950, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1)").run(id, id, id, `t${id}@x`, subject, subject, JSON.stringify({ name: 'Someone', email: from }), from, date, category);
  db.prepare('INSERT OR REPLACE INTO bodies(message_row, text) VALUES (?, ?)').run(id, text);
}

describe('marking important mail and brand deals', () => {
  beforeEach(() => {
    calls.length = 0;
    answers.length = 0;
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (95, 'me@triage.test', 'me', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (950, 95, 'INBOX', 'INBOX', 'inbox')");
    db.exec('DELETE FROM ai_triage; DELETE FROM sender_groups; DELETE FROM messages WHERE id = 95111');
    setSetting('ai.key', encrypt('sk-ant-test-0000000000000000000000'));
    setSetting('ai.usage', { month: new Date().toISOString().slice(0, 7), usd: 0, calls: 0 });
    setSetting('ai.capUsd', 20);
    setSetting('ai.triageDay', { day: '2000-01-01', n: 0 });
    setSetting('ai.triageSince', new Date(Date.now() - 60_000).toISOString());
    setSetting('ai.triage', { enabled: true, model: 'claude-haiku-5-5' });
  });

  it('asks Haiku only about mail from people, and marks the important ones', async () => {
    mail(9501, 'anna@client.test', 'Preventivo video matrimonio', 'Ciao, ci serve il preventivo entro venerdì.');
    mail(9502, 'no-reply@shop.test', 'Your receipt', 'Thanks for your order', 'notification');
    mail(9503, 'old@client.test', 'Old one', 'from last year', 'person', '2020-01-01T00:00:00Z');
    answers.push({ kind: 'client', important: true, reason: 'Client needs a quote by Friday' });
    for (const id of [9501, 9502, 9503]) considerMessage(id);
    await wait(100);
    expect(calls).toHaveLength(1); // the receipt and last year's email never reach Claude
    expect(calls[0].model).toBe('claude-haiku-5-5');
    expect(calls[0].fallbacks).toBeUndefined(); // Haiku has no server-side fallback
    expect(calls[0].user).toContain('<email>');
    const t = threadView(db.prepare('SELECT * FROM threads WHERE id = 9501').get() as never);
    expect(t.important).toBe(true);
    expect(t.importantReason).toBe('Client needs a quote by Friday');
    // Haiku prices: 1500 in, 200 out -> $0.00025
    expect((getSetting('ai.usage', { usd: 0 }) as { usd: number }).usd).toBeLessThan(0.001);
    considerMessage(9501); // never twice
    await wait(50);
    expect(calls).toHaveLength(1);
  });

  it('puts brand deals in their own group, important or not, until you reply', async () => {
    mail(9511, 'partnerships@brand.test', 'Paid collaboration for your channel', 'We would like to sponsor a video, budget 800 EUR, answer by Monday.');
    mail(9512, 'outreach@agency.test', 'Collab opportunity', 'Hi creator, free product for a review?');
    answers.push({ kind: 'brand_deal', important: true, reason: 'Paid sponsorship, answer by Monday' });
    answers.push({ kind: 'brand_deal', important: false, reason: 'Generic gifting outreach' });
    considerMessage(9511);
    considerMessage(9512);
    for (let i = 0; i < 80 && (db.prepare("SELECT COUNT(*) AS n FROM ai_triage WHERE message_row IN (9511, 9512)").get() as { n: number }).n < 2; i++) await wait(100); // calls are paced 1.5 s apart
    refreshGroupThreads(true);
    const ids = groupedInboxThreads(95, 'Brand deals').map((r) => r.id).sort();
    expect(ids).toEqual([9511, 9512]);
    // You reply: the conversation comes back to the inbox.
    db.prepare("INSERT INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size, mine) VALUES (95111, 95, 950, 9511, 95111, 'r@x', 'Re', 're', 'me@triage.test', ?, 1, 1)").run(new Date().toISOString());
    refreshGroupThreads(true);
    expect(groupedInboxThreads(95, 'Brand deals').map((r) => r.id)).toEqual([9512]);
  });

  it('does nothing when switched off', async () => {
    setTriageSettings({ enabled: false });
    mail(9521, 'friend@mail.test', 'Ciao', 'Ci vediamo stasera?');
    considerMessage(9521);
    await wait(50);
    expect(calls).toHaveLength(0);
  });
});
