import { describe, it, expect } from 'vitest';
import { db } from './db.js';
import { messageText, storeMessages, waChats, waMessages, waSearch, resolveChat, waStatus } from './whatsapp.js';

describe('whatsapp store', () => {
  it('starts off: nothing connects until linked', () => {
    expect(waStatus().state).toBe('off');
  });
  it('keeps text, tags media, skips reactions and status', () => {
    expect(messageText({ conversation: 'ciao' })).toBe('ciao');
    expect(messageText({ extendedTextMessage: { text: 'link http://x' } })).toBe('link http://x');
    expect(messageText({ imageMessage: { caption: 'look' } })).toBe('[photo] look');
    expect(messageText({ audioMessage: { ptt: true } })).toBe('[voice message]');
    expect(messageText({ ephemeralMessage: { message: { conversation: 'hidden' } } })).toBe('hidden');
    expect(messageText({ reactionMessage: { text: '👍' } })).toBeNull();
    db.exec('DELETE FROM wa_messages; DELETE FROM wa_chats; DELETE FROM wa_contacts;');
    const n = storeMessages([
      { key: { remoteJid: '393330000001@s.whatsapp.net', id: 'a1', fromMe: false }, pushName: 'Marco', messageTimestamp: 1_800_000_000, message: { conversation: 'Ci vediamo domani?' } },
      { key: { remoteJid: '393330000001@s.whatsapp.net', id: 'a2', fromMe: true }, messageTimestamp: 1_800_000_100, message: { conversation: 'Sì, alle 9' } },
      { key: { remoteJid: 'status@broadcast', id: 's1', fromMe: false }, messageTimestamp: 1_800_000_200, message: { conversation: 'story' } },
      { key: { remoteJid: '1203630@g.us', id: 'g1', fromMe: false, participant: '393330000002@s.whatsapp.net' }, pushName: 'Anna', messageTimestamp: 1_800_000_300, message: { conversation: 'Benvenuti nel gruppo' } },
    ] as never, true);
    expect(n).toBe(3);
    const chats = waChats('', 10);
    expect(chats.map((c) => c.name)).toEqual(['+1203630', 'Marco']);
    expect(chats[1].unread).toBe(1);
    const r = resolveChat('marco');
    expect(r).toEqual({ jid: '393330000001@s.whatsapp.net', name: 'Marco' });
    expect(waMessages('393330000001@s.whatsapp.net', 10).map((m) => `${m.from}: ${m.text}`)).toEqual(['Marco: Ci vediamo domani?', 'Me: Sì, alle 9']);
    expect(waChats('', 10)[1].unread).toBe(0);
    expect(waSearch('domani', 5)[0]).toMatchObject({ chat: 'Marco', from: 'Marco' });
    db.exec('DELETE FROM wa_messages; DELETE FROM wa_chats; DELETE FROM wa_contacts;');
  });
});
