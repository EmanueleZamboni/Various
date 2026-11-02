import { describe, it, expect } from 'vitest';
import { db } from './db.js';
import './groups.js';
import { listThreads } from './routes/threads.js';

describe('sender groups', () => {
  it('groups only conversations made entirely of the exact grouped address', () => {
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (77, 'me@grp.test', 'me', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (770, 77, 'INBOX', 'INBOX', 'inbox')");
    const thread = (id: number) => db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, inbox_date, roles, msg_count) VALUES (?, 77, 's', 's', '2026-11-01', '2026-11-01', ',inbox,', 1)").run(id);
    const msg = (id: number, t: number, from: string, mine = 0) =>
      db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_email, date, size, mine) VALUES (?, 77, 770, ?, ?, ?, 's', 's', ?, '2026-11-01', 1, ?)").run(id, t, id, `m${id}@x`, from, mine);
    thread(7701); msg(77011, 7701, 'alerts@amazon.test');                    // only the grouped sender
    thread(7702); msg(77021, 7702, 'alerts@amazon.test'); msg(77022, 7702, 'me@grp.test', 1); // I replied: stays normal
    thread(7703); msg(77031, 7703, 'person@amazon.test');                    // same domain, other address: stays normal
    db.exec("DELETE FROM sender_groups; INSERT INTO sender_groups(email, group_name) VALUES ('alerts@amazon.test', 'Amazon')");
    const ids = (r: ReturnType<typeof listThreads>) => r.threads.map((t) => Number(t.id)).filter((id) => id >= 7701 && id <= 7703).sort();
    expect(ids(listThreads({ view: 'inbox', account: '77', group: 'Amazon' }))).toEqual([7701]);
    expect(ids(listThreads({ view: 'inbox', account: '77', group: 'none' }))).toEqual([7702, 7703]);
    expect(ids(listThreads({ view: 'inbox', account: '77' }))).toEqual([7701, 7702, 7703]);
    db.exec('DELETE FROM sender_groups');
  });
});
