import { EventEmitter } from 'node:events';

export type AppEvent =
  | { type: 'thread.updated'; threadId: string; accountId: string }
  | { type: 'thread.removed'; threadId: string }
  | { type: 'message.updated'; messageId: string; threadId: string }
  | { type: 'account.updated'; account: unknown }
  | { type: 'folder.updated'; folder: unknown }
  | { type: 'sync.progress'; accountId: string; fetched: number; total: number; done: boolean }
  | { type: 'action.failed'; message: string }
  | { type: 'new.mail'; threadId: string; accountId: string; from: { name: string; email: string }; subject: string; category: string };

class Bus extends EventEmitter {
  publish(ev: AppEvent): void {
    this.emit('event', ev);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
