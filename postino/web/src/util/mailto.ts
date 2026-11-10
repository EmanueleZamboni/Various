/** A mailto: link as composer fields (RFC 6068: to, cc, bcc, subject, body). */
export function parseMailto(href: string): { to: string; cc: string; bcc: string; subject: string; text: string } | null {
  const raw = String(href || '').trim();
  if (!/^mailto:/i.test(raw)) return null;
  const rest = raw.slice(7);
  const q = rest.indexOf('?');
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s.replace(/\+/g, '%20'));
    } catch {
      return s;
    }
  };
  const list: Record<string, string[]> = { to: [], cc: [], bcc: [] };
  const head = q >= 0 ? rest.slice(0, q) : rest;
  if (head) list.to.push(dec(head));
  let subject = '';
  let text = '';
  for (const pair of (q >= 0 ? rest.slice(q + 1) : '').split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = dec(eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase();
    const v = dec(eq >= 0 ? pair.slice(eq + 1) : '');
    if (k === 'to' || k === 'cc' || k === 'bcc') list[k].push(v);
    else if (k === 'subject') subject = v;
    else if (k === 'body') text = v;
  }
  const join = (a: string[]) => a.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean).join(', ');
  return { to: join(list.to), cc: join(list.cc), bcc: join(list.bcc), subject, text };
}
