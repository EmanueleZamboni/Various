import { describe, it, expect } from 'vitest';
import { db } from './db.js';
import { messageText, storeMessages, waChats, waMessages, waSearch, resolveChat, waStatus, transcribeAudio, applyTranscript, transcriptionStatus, setTranscriptionKey, transcriptionKey } from './whatsapp.js';

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

describe('whatsapp voice notes', () => {
  const jid = '393330000001@s.whatsapp.net';
  const note = { key: { remoteJid: jid, id: 'v1', fromMe: false }, pushName: 'Marco', messageTimestamp: 1_800_000_500, message: { audioMessage: { ptt: true, seconds: 7, mimetype: 'audio/ogg; codecs=opus' } } };
  it('is off until a key is saved; the key is stored encrypted', () => {
    delete process.env.GROQ_API_KEY;
    setTranscriptionKey('');
    expect(transcriptionStatus().enabled).toBe(false);
    setTranscriptionKey('gsk_testtesttesttesttesttest');
    expect(transcriptionKey()).toEqual({ key: 'gsk_testtesttesttesttesttest', source: 'settings' });
    const raw = db.prepare("SELECT value FROM settings WHERE key = 'whatsapp.transcribeKey'").get() as { value: string };
    expect(raw.value).not.toContain('gsk_');
    setTranscriptionKey('');
    expect(transcriptionKey()).toBeNull();
  });
  it('sends the audio to Groq as a file and returns the text', async () => {
    const seen: { url: string; auth: string; name: string; model: string; size: number }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get('file') as File;
      seen.push({ url: String(url), auth: String((init?.headers as Record<string, string>).Authorization), name: file.name, model: String(form.get('model')), size: file.size });
      return new Response(JSON.stringify({ text: '  Ci vediamo alle nove davanti al bar.  ' }), { status: 200 });
    }) as typeof fetch;
    const text = await transcribeAudio(Buffer.from('OggS fake audio'), 'audio/ogg; codecs=opus', 'gsk_abc', fakeFetch);
    expect(text).toBe('Ci vediamo alle nove davanti al bar.');
    expect(seen[0]).toMatchObject({ url: 'https://api.groq.com/openai/v1/audio/transcriptions', auth: 'Bearer gsk_abc', name: 'voice.ogg', model: 'whisper-large-v3-turbo', size: 15 });
    const failing = (async () => new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 })) as typeof fetch;
    await expect(transcribeAudio(Buffer.from('x'), 'audio/ogg', 'gsk_bad', failing)).rejects.toThrow('Invalid API Key');
  });
  it('keeps the tag in front of the transcript, searches it, and a redelivery does not wipe it', () => {
    db.exec('DELETE FROM wa_messages; DELETE FROM wa_chats; DELETE FROM wa_contacts;');
    expect(storeMessages([note] as never, true)).toBe(1);
    expect(waMessages(jid, 5)[0].text).toBe('[voice message]');
    applyTranscript(jid, 'v1', 'Ci vediamo alle nove\n davanti al bar.');
    expect(waMessages(jid, 5)[0].text).toBe('[voice message] Ci vediamo alle nove davanti al bar.');
    expect(waSearch('davanti al bar', 5)[0]).toMatchObject({ from: 'Marco' });
    storeMessages([note] as never, true); // WhatsApp delivers the same message again
    expect(waMessages(jid, 5)[0].text).toBe('[voice message] Ci vediamo alle nove davanti al bar.');
    applyTranscript(jid, 'v1', '   ');
    expect(waMessages(jid, 5)[0].text).toBe('[voice message] (nothing understood)');
    db.exec('DELETE FROM wa_messages; DELETE FROM wa_chats; DELETE FROM wa_contacts;');
  });
});
