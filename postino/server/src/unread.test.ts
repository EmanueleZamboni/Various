import { describe, it, expect } from 'vitest';
import { unreadCount } from './mail/store.js';

describe('unread count', () => {
  it('never counts what I sent', () => {
    const r = (message_id: string, seen: number, mine: number, role: string) => ({ message_id, seen, mine, role: role as never });
    expect(unreadCount([r('a', 0, 0, 'inbox')])).toBe(1);
    expect(unreadCount([r('a', 0, 1, 'sent')])).toBe(0); // my sent copy, unflagged by the server
    expect(unreadCount([r('a', 0, 0, 'sent')])).toBe(0);
    expect(unreadCount([r('a', 0, 0, 'drafts')])).toBe(0);
    expect(unreadCount([r('a', 1, 1, 'sent'), r('a', 0, 0, 'inbox')])).toBe(0); // mail to myself
    expect(unreadCount([r('a', 0, 0, 'inbox'), r('a', 0, 0, 'archive'), r('b', 0, 0, 'inbox')])).toBe(2); // copies count once
  });
});
