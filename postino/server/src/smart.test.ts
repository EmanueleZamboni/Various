import { describe, it, expect } from 'vitest';
import { cardFor, parseDay, upcoming, noteMessage } from './smart.js';
import { canUnsubscribe } from './views.js';
import { db } from './db.js';

// Real layouts (personal details replaced).
const AMAZON_TEXT = `Your Orders
https://www.amazon.it/gp/css/order-history?ref_=fed_yo_default
    Your package was dispatched!
Ordered

Dispatched

Out for delivery

Delivered

Arriving Tuesday

Mario – Bologna

Order #
123-4567890-1234567

Track package
https://www.amazon.it/progress-tracker/package?_encoding=UTF8&orderId=123-4567890-1234567&packageIndex=0&shipmentId=AbCdEf123&ref_=p_btn_fed_track_package

* USB-C Cable 1 m - 1 m`;
const AMAZON_HTML = `<p><a href="https://www.amazon.it/progress-tracker/package?orderId=123-4567890-1234567&amp;packageIndex=0">Track package</a></p>`;

const TRENITALIA_TEXT = `Conferma di acquisto
Regionale Veloce 1234 del 12/11/2026
Bologna Centrale (10:05) - Milano Centrale (11:20)
Passeggero MARIO ROSSI
Offerta/Servizio ORDINARIA/2ª CLASSE PRENOTAZIONE
Importo Eur 11.60
Codice Cambio Prenotazione (CP) 654321
Codice Biglietto 1234567890`;

describe('dates in words', () => {
  const fri = new Date('2026-11-06T14:15:38Z'); // a Friday in Italy
  it('reads today, tomorrow, weekdays and dates relative to the email', () => {
    expect(parseDay('today', fri)).toBe('2026-11-06');
    expect(parseDay('domani', fri)).toBe('2026-11-07');
    expect(parseDay('Tuesday', fri)).toBe('2026-11-10');
    expect(parseDay('martedì 10 novembre', fri)).toBe('2026-11-10');
    expect(parseDay('mar 10 nov', fri)).toBe('2026-11-10');
    expect(parseDay('10/11/2026', fri)).toBe('2026-11-10');
    expect(parseDay('5 Jan', new Date('2026-12-28T10:00:00Z'))).toBe('2027-01-05');
    expect(parseDay('soon', fri)).toBe('');
  });
});

describe('cards from rules', () => {
  it('Amazon: item, status, arriving day, order and the tracking link', () => {
    const c = cardFor({ fromEmail: 'conferma-spedizione@amazon.it', fromName: 'Amazon.it', subject: 'Dispatched: ‘USB-C Cable...’', text: AMAZON_TEXT, html: AMAZON_HTML, date: '2026-11-06T14:15:38.000Z' });
    expect(c).toMatchObject({ kind: 'package', title: 'USB-C Cable', status: 'shipped', expected: '2026-11-10', orderId: '123-4567890-1234567' });
    expect(c && c.kind === 'package' && c.trackingUrl).toContain('https://www.amazon.it/progress-tracker/package');
    const more = cardFor({ fromEmail: 'shipment-tracking@amazon.it', fromName: 'Amazon.it', subject: 'Out for delivery: ‘LED Video Light...’ and 1 more item', text: AMAZON_TEXT, html: AMAZON_HTML, date: '2026-11-05T09:30:40.000Z' });
    expect(more).toMatchObject({ status: 'out_for_delivery', title: 'LED Video Light + 1 more', expected: '2026-11-05' });
    // Not an order update: no card.
    expect(cardFor({ fromEmail: 'no-reply@amazon.it', fromName: 'Amazon', subject: 'Your monthly spending summary', text: 'Total spent 424,12 €', html: '', date: '2026-11-03T22:52:37.000Z' })).toBeNull();
  });

  it('Trenitalia: train, route, times, ticket and CP codes', () => {
    const c = cardFor({ fromEmail: 'webmaster@trenitalia.it', fromName: 'Trenitalia', subject: 'Il Tuo Biglietto Trenitalia', text: TRENITALIA_TEXT, html: '', date: '2026-11-06T13:45:40.000Z' });
    expect(c).toMatchObject({ kind: 'trip', mode: 'train', operator: 'Trenitalia', number: 'Regionale Veloce 1234', from: 'Bologna Centrale', to: 'Milano Centrale', depart: '2026-11-12T10:05', arrive: '2026-11-12T11:20', bookingRef: '1234567890 · CP 654321' });
  });

  it('schema.org markup, as senders write it for Gmail', () => {
    const raw = `<html><script type="application/ld+json">{"@context":"http://schema.org","@type":"ParcelDelivery","expectedArrivalUntil":"2026-11-12T20:00:00+01:00","carrier":{"@type":"Organization","name":"BRT"},"trackingNumber":"123456789012","trackingUrl":"https://vas.brt.it/vas/sped_det_show.htm?brtCode=123","itemShipped":{"@type":"Product","name":"Treppiede"},"partOfOrder":{"@type":"Order","orderNumber":"A-77","merchant":{"@type":"Organization","name":"Shop"}}}</script></html>`;
    const c = cardFor({ fromEmail: 'ordini@shop.it', fromName: 'Shop', subject: 'Il tuo ordine', text: '', html: '', rawHtml: raw, date: '2026-11-07T08:00:00Z' });
    expect(c).toMatchObject({ kind: 'package', title: 'Treppiede', carrier: 'BRT', trackingNumber: '123456789012', expected: '2026-11-12', orderId: 'A-77', trackingUrl: 'https://vas.brt.it/vas/sped_det_show.htm?brtCode=123' });
    const flight = `<script type="application/ld+json">[{"@context":"http://schema.org","@type":"FlightReservation","reservationNumber":"XKQ12B","reservationStatus":"http://schema.org/ReservationConfirmed","reservationFor":{"@type":"Flight","flightNumber":"1234","airline":{"@type":"Airline","name":"ITA Airways","iataCode":"AZ"},"departureAirport":{"@type":"Airport","name":"Bologna","iataCode":"BLQ"},"departureTime":"2026-12-01T07:05:00+01:00","arrivalAirport":{"@type":"Airport","name":"Roma Fiumicino","iataCode":"FCO"},"arrivalTime":"2026-12-01T08:10:00+01:00"}}]</script>`;
    expect(cardFor({ fromEmail: 'noreply@ita-airways.com', fromName: 'ITA', subject: 'Booking', text: '', html: '', rawHtml: flight, date: '2026-11-07T08:00:00Z' })).toMatchObject({ kind: 'trip', mode: 'flight', number: 'AZ1234', from: 'Bologna', to: 'Roma Fiumicino', depart: '2026-12-01T07:05', bookingRef: 'XKQ12B' });
  });

  it('a tracking link to a stranger\'s site is never shown, promos never make cards', () => {
    const phish = cardFor({ fromEmail: 'info@poste-avvisi.top', fromName: 'Poste', subject: 'Il tuo pacco è in giacenza', text: 'Numero di spedizione: AB123456789IT', html: '<a href="https://evil.example/pay">Traccia il pacco</a>', date: '2026-11-07T08:00:00Z' });
    expect(phish && phish.kind === 'package' && phish.trackingUrl).toBe('');
    expect(cardFor({ fromEmail: 'news@shop.it', fromName: 'Shop', subject: 'Spedizione gratis e 20% di sconto!', text: '', html: '<a href="https://shop.it/x">Traccia</a>', date: '2026-11-07T08:00:00Z' })).toBeNull();
  });
});

describe('upcoming and unsubscribe', () => {
  it('shows the newest update of each parcel and trips still ahead', () => {
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (93, 'me@smart.test', 'me', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (930, 93, 'INBOX', 'INBOX', 'inbox')");
    const now = new Date();
    const add = (id: number, subject: string, from: string, text: string, html: string, at: Date) => {
      db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, roles, msg_count) VALUES (?, 93, ?, ?, ?, ',inbox,', 1)").run(id, subject, subject, at.toISOString());
      db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_json, from_email, date, size, body_fetched, list_unsubscribe) VALUES (?, 93, 930, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, '<https://x/unsub>')").run(id, id, id, `s${id}@x`, subject, subject, JSON.stringify({ name: 'X', email: from }), from, at.toISOString());
      db.prepare('INSERT OR REPLACE INTO bodies(message_row, text, html) VALUES (?, ?, ?)').run(id, text, html);
      noteMessage(id);
    };
    const earlier = new Date(now.getTime() - 3600_000);
    add(9301, 'Dispatched: ‘Smart LED bulb...’', 'conferma-spedizione@amazon.it', 'Arriving tomorrow\nOrder #\n408-1111111-2222222', AMAZON_HTML, earlier);
    add(9302, 'Out for delivery: ‘Smart LED bulb...’', 'shipment-tracking@amazon.it', 'Order #\n408-1111111-2222222', AMAZON_HTML, now);
    const day = new Date(now.getTime() + 2 * 86_400_000).toISOString().slice(0, 10).split('-').reverse().join('/');
    add(9303, 'Il Tuo Biglietto Trenitalia', 'webmaster@trenitalia.it', TRENITALIA_TEXT.replace('12/11/2026', day), '', now);
    const u = upcoming(now);
    const mine = u.packages.filter((p) => (p as { threadId: string }).threadId.startsWith('930'));
    expect(mine).toHaveLength(1);
    expect((mine[0] as { card: { status: string } }).card.status).toBe('out_for_delivery');
    expect(u.trips.some((t) => (t as { threadId: string }).threadId === '9303')).toBe(true);
    // Order updates and tickets have List-Unsubscribe, but there is nothing to unsubscribe from.
    const row = (id: number) => db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as never;
    expect(canUnsubscribe(row(9302))).toBe(false);
    expect(canUnsubscribe(row(9303))).toBe(false);
    db.prepare("UPDATE messages SET subject = 'Le novità di novembre', from_email = 'news@brand.example' WHERE id = 9301").run();
    expect(canUnsubscribe(row(9301))).toBe(true);
    db.exec('DELETE FROM smart_items WHERE thread_id BETWEEN 9301 AND 9303; DELETE FROM bodies WHERE message_row BETWEEN 9301 AND 9303; DELETE FROM messages WHERE id BETWEEN 9301 AND 9303; DELETE FROM threads WHERE id BETWEEN 9301 AND 9303');
  });
});

describe('hiding from Upcoming', () => {
  it('a swiped-away parcel stays hidden, Undo brings it back', async () => {
    const { hideItem } = await import('./smart.js');
    db.exec("INSERT OR IGNORE INTO accounts(id, email, name, color, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, password_enc) VALUES (94, 'me@hide.test', 'me', '#000', 'h', 993, 1, 'h', 465, 1, 'u', 'x')");
    db.exec("INSERT OR IGNORE INTO folders(id, account_id, path, name, role) VALUES (940, 94, 'INBOX', 'INBOX', 'inbox')");
    const now = new Date();
    db.prepare("INSERT OR REPLACE INTO threads(id, account_id, subject, subject_norm, last_date, roles, msg_count) VALUES (9401, 94, 's', 's', ?, ',inbox,', 1)").run(now.toISOString());
    db.prepare("INSERT OR REPLACE INTO messages(id, account_id, folder_id, thread_id, uid, message_id, subject, subject_norm, from_json, from_email, date, size, body_fetched) VALUES (9401, 94, 940, 9401, 1, 'h1@x', ?, 's', '{}', 'shipment-tracking@amazon.it', ?, 1, 1)").run('Out for delivery: ‘Desk lamp...’', now.toISOString());
    db.prepare('INSERT OR REPLACE INTO bodies(message_row, text, html) VALUES (9401, ?, ?)').run('Order #\n111-2222222-3333333', '');
    noteMessage(9401);
    const has = () => upcoming(now).packages.some((p) => (p as { threadId: string }).threadId === '9401');
    expect(has()).toBe(true);
    const key = (upcoming(now).packages.find((p) => (p as { threadId: string }).threadId === '9401') as { key: string }).key;
    hideItem(key);
    expect(has()).toBe(false);
    hideItem(key, false);
    expect(has()).toBe(true);
    db.exec('DELETE FROM smart_items WHERE message_row = 9401; DELETE FROM bodies WHERE message_row = 9401; DELETE FROM messages WHERE id = 9401; DELETE FROM threads WHERE id = 9401');
  });
});
