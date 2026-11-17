import { describe, it, expect } from 'vitest';
import { unreadCount } from './store.js';

describe('unread count', () => {
  it('a message read in any of its copies is read', () => {
    expect(unreadCount([
      { message_id: '<a@x>', seen: 1, mine: 0, role: 'inbox' },
      { message_id: '<a@x>', seen: 0, mine: 0, role: 'archive' },
    ])).toBe(0);
    expect(unreadCount([
      { message_id: '<a@x>', seen: 0, mine: 0, role: 'inbox' },
      { message_id: '<a@x>', seen: 0, mine: 0, role: 'archive' },
      { message_id: '<b@x>', seen: 0, mine: 0, role: 'inbox' },
    ])).toBe(2);
  });
});
