const TZ = 'Europe/Rome';

/** Minutes east of UTC that Italy is at this instant (60 in winter, 120 in summer). */
function offsetMinutes(at: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60_000);
}

/**
 * A send time from the connector: an ISO time with Z or an offset, or a plain local time
 * ("2026-11-12T09:00", "2026-11-12 09:00"), read as Italian time. In the future, within a year.
 */
export function parseSendAt(raw: string, now = Date.now()): Date {
  const s = raw.trim().replace(' ', 'T');
  let at: number;
  const local = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (local) {
    const [, y, mo, d, h, mi, se] = local.map(Number) as number[];
    const guess = Date.UTC(y, mo - 1, d, h, mi, se || 0);
    at = guess - offsetMinutes(guess) * 60_000;
    at = guess - offsetMinutes(at) * 60_000; // across a daylight-saving change
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    at = new Date(s).getTime();
  } else {
    throw new Error('send_at must look like 2026-11-12T09:00 (Italian time) or an ISO time with offset.');
  }
  if (Number.isNaN(at)) throw new Error('send_at is not a valid time.');
  if (at < now - 60_000) throw new Error('send_at is in the past.');
  if (at > now + 366 * 86_400_000) throw new Error('send_at is more than a year away.');
  return new Date(at);
}
