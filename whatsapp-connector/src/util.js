// Small helpers shared by the store, the WhatsApp client and the MCP tools.

import { getContentType, normalizeMessageContent } from 'baileys';

/** Lower-case and strip accents, so "perché" matches "perche". */
export function fold(text) {
  return (text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function toSeconds(ts) {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'object' && typeof ts.toNumber === 'function') return ts.toNumber();
  return Number(ts) || 0;
}

const TZ = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const fmt = new Intl.DateTimeFormat('sv-SE', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** "2026-11-02 14:05" in the configured time zone. */
export function formatTime(seconds) {
  return seconds ? fmt.format(new Date(seconds * 1000)) : '?';
}

/** Parses "2026-10-01" or "2026-10-01T14:00" (local time) into unix seconds. */
export function parseTime(value, name) {
  if (!value) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00` : value);
  if (Number.isNaN(ms)) throw new Error(`${name}: can't read "${value}" as a date, use e.g. 2026-10-01 or 2026-10-01T14:00`);
  return Math.floor(ms / 1000);
}

export function phoneFromJid(jid) {
  const m = /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid || '');
  return m ? `+${m[1]}` : undefined;
}

const MEDIA_TYPES = {
  imageMessage: 'image',
  videoMessage: 'video',
  audioMessage: 'audio',
  documentMessage: 'document',
  stickerMessage: 'sticker',
  ptvMessage: 'video',
};

/**
 * Turns a WhatsApp message into the fields we store, or null for things that are
 * not worth showing (reactions, protocol messages, key distribution, ...).
 * Edits and deletions are returned as { edit } / { revoke } so the store can apply them.
 */
export function describeMessage(message) {
  let content = normalizeMessageContent(message);
  if (!content) return null;
  if (content.documentWithCaptionMessage) content = normalizeMessageContent(content.documentWithCaptionMessage.message);

  const protocol = content.protocolMessage;
  if (protocol) {
    // type 0 = REVOKE, 14 = MESSAGE_EDIT
    if (protocol.type === 0 && protocol.key?.id) return { revoke: protocol.key.id };
    if (protocol.type === 14 && protocol.key?.id && protocol.editedMessage) {
      const edited = describeMessage(protocol.editedMessage);
      return edited?.text != null ? { edit: protocol.key.id, text: edited.text } : null;
    }
    return null;
  }

  const type = getContentType(content);
  if (!type) return null;
  const inner = content[type];
  const quotedId = inner?.contextInfo?.stanzaId || undefined;

  if (type === 'conversation') return { type: 'text', text: content.conversation };
  if (type === 'extendedTextMessage') return { type: 'text', text: inner.text, quotedId };

  if (MEDIA_TYPES[type]) {
    let kind = MEDIA_TYPES[type];
    if (type === 'audioMessage' && inner.ptt) kind = 'voice';
    return {
      type: kind,
      text: inner.caption || '',
      mime: inner.mimetype || undefined,
      fileName: inner.fileName || undefined,
      seconds: inner.seconds || undefined,
      quotedId,
      media: true,
    };
  }

  if (type === 'locationMessage' || type === 'liveLocationMessage') {
    const name = [inner.name, inner.address].filter(Boolean).join(', ');
    return { type: 'location', text: `${name ? `${name} ` : ''}(${inner.degreesLatitude}, ${inner.degreesLongitude})`, quotedId };
  }
  if (type === 'contactMessage') return { type: 'contact', text: inner.displayName || '', quotedId };
  if (type === 'contactsArrayMessage') {
    return { type: 'contact', text: (inner.contacts || []).map(c => c.displayName).join(', '), quotedId };
  }
  if (type.startsWith('pollCreationMessage')) {
    return { type: 'poll', text: `${inner.name} [${(inner.options || []).map(o => o.optionName).join(' / ')}]`, quotedId };
  }
  if (type === 'eventMessage') return { type: 'event', text: [inner.name, inner.description].filter(Boolean).join(': '), quotedId };
  if (type === 'buttonsResponseMessage') return { type: 'text', text: inner.selectedDisplayText || '', quotedId };
  if (type === 'listResponseMessage') return { type: 'text', text: inner.title || '', quotedId };
  if (type === 'templateMessage') {
    const t = inner.hydratedTemplate || inner.hydratedFourRowTemplate;
    return t?.hydratedContentText ? { type: 'text', text: t.hydratedContentText } : null;
  }
  // reactionMessage, senderKeyDistributionMessage, pollUpdateMessage, messageContextInfo, ...
  return null;
}
