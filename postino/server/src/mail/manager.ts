import { db } from '../db.js';
import { log } from '../log.js';
import type { AccountRow } from '../views.js';
import { AccountSync } from './sync.js';

/** Owns one AccountSync per enabled account. */
class SyncManager {
  private syncs = new Map<number, AccountSync>();

  startAll(): void {
    const rows = db.prepare('SELECT * FROM accounts WHERE enabled = 1 ORDER BY sort_order, id').all() as AccountRow[];
    for (const a of rows) this.start(a);
  }

  start(account: AccountRow): AccountSync {
    const existing = this.syncs.get(account.id);
    if (existing) return existing;
    const s = new AccountSync(account);
    this.syncs.set(account.id, s);
    s.start();
    log.info({ account: account.email }, 'sync started');
    return s;
  }

  get(accountId: number): AccountSync | undefined {
    return this.syncs.get(accountId);
  }

  require(accountId: number): AccountSync {
    const s = this.syncs.get(accountId);
    if (!s) throw Object.assign(new Error('Account is not running'), { statusCode: 409 });
    return s;
  }

  async stop(accountId: number): Promise<void> {
    const s = this.syncs.get(accountId);
    if (!s) return;
    this.syncs.delete(accountId);
    await s.stop();
  }

  async restart(accountId: number): Promise<void> {
    await this.stop(accountId);
    const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
    if (a && a.enabled) this.start(a);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.syncs.keys()].map((id) => this.stop(id)));
  }

  all(): AccountSync[] {
    return [...this.syncs.values()];
  }
}

export const manager = new SyncManager();
