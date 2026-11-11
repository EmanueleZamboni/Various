import { describe, it, expect } from 'vitest';
import { parseSendAt } from './sendAt.js';
import { db } from './db.js';
import { encrypt } from './crypto.js';
import { _test } from './mcp.js';

const now = Date.parse('2026-11-11T10:00:00Z');

describe('scheduled send times', () => {
  it('reads plain times as Italian time, winter and summer', () => {
    expect(parseSendAt('2026-11-12T09:00', now).toISOString()).toBe('2026-11-12T08:00:00.000Z');
    expect(parseSendAt('2027-07-01 09:30', now).toISOString()).toBe('2027-07-01T07:30:00.000Z');
    expect(parseSendAt('2026-11-12T09:00:00+02:00', now).toISOString()).toBe('2026-11-12T07:00:00.000Z');
    expect(parseSendAt('2026-11-12T09:00Z', now).toISOString()).toBe('2026-11-12T09:00:00.000Z');
  });
  it('refuses the past, far future and nonsense', () => {
    expect(() => parseSendAt('2026-11-10T09:00', now)).toThrow(/past/);
    expect(() => parseSendAt('2028-11-10T09:00', now)).toThrow(/year/);
    expect(() => parseSendAt('tomorrow morning', now)).toThrow(/look like/);
  });

  it('schedules from the connector, lists and cancels back to a draft', async () => {
    db.prepare(`INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc, enabled)
      VALUES (88, 'sched@test.local', 'S', '#000', 'h', 1, 1, 'h', 1, 1, 'u', ?, 0)`).run(encrypt('x'));
    const tool = (name: string) => _test.TOOLS.find((t) => t.name === name)!;
    const when = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 16).replace(/:\d\d$/, ':00');
    const r = (await tool('send_email').run({ account_id: '88', to: 'friend@example.com', subject: 'Later', body: 'Made-up text', send_at: when })) as { scheduled: boolean; outbox_id: string };
    expect(r.scheduled).toBe(true);
    const list = (await tool('list_scheduled').run({})) as { scheduled: { outbox_id: string; subject: string }[] };
    expect(list.scheduled.find((s) => s.outbox_id === r.outbox_id)?.subject).toBe('Later');
    const c = (await tool('cancel_scheduled').run({ outbox_id: r.outbox_id })) as { ok: boolean; draft_id: string };
    expect(c.ok).toBe(true);
    expect((db.prepare('SELECT subject FROM drafts WHERE id = ?').get(Number(c.draft_id)) as { subject: string }).subject).toBe('Later');
    await expect(Promise.resolve().then(() => tool('cancel_scheduled').run({ outbox_id: r.outbox_id }))).rejects.toThrow(/already sent or cancelled/);
  });
});
