/**
 * The kill switch of Ema's Segretario. When the Segretario says it is switched off ("bloccato"), Postino
 * refuses everything (web app, API, the Claude connector and its OAuth) except /api/health, until Ema
 * writes /riaccendi to the Telegram bot. The state is read from the Segretario on the shared Docker
 * network every 5 seconds; if the Segretario does not answer, the last known state is kept. Postino
 * starts open, so a Segretario that is down never locks the mail out by itself.
 */
const BLOCCO_URL = process.env.SEGRETARIO_BLOCCO_URL ?? 'http://segretario:8766/blocco';
const EVERY_MS = 5_000;

let locked = false;
let timer: NodeJS.Timeout | undefined;

async function refresh(): Promise<void> {
  try {
    const r = await fetch(BLOCCO_URL, { signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return;
    const j = (await r.json()) as { bloccato?: unknown };
    locked = j?.bloccato === true;
  } catch {
    // Segretario unreachable: keep the last answer.
  }
}

export function startBloccoWatch(): void {
  if (timer || !BLOCCO_URL || process.env.VITEST) return;
  void refresh();
  timer = setInterval(() => void refresh(), EVERY_MS);
  timer.unref();
}

export function isLocked(): boolean {
  return locked;
}

/** Tests only. */
export function setLockedForTest(v: boolean): void {
  locked = v;
}

const PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Postino</title></head><body style="font:16px system-ui;margin:48px auto;max-width:420px;padding:0 16px"><h1>Chiuso</h1><p>Postino è spento dal Segretario. Per riaprire scrivi <b>/riaccendi</b> al bot Telegram.</p></body></html>`;

/** Fastify onRequest hook: everything but /api/health gets a 503 while the Segretario is switched off. */
export async function bloccoHook(req: { url: string; headers: Record<string, unknown> }, reply: {
  code: (n: number) => { header: (k: string, v: string) => { send: (b: unknown) => unknown } };
}): Promise<unknown> {
  if (!locked) return undefined;
  const path = req.url.split('?')[0];
  if (path === '/api/health') return undefined;
  const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
  return reply
    .code(503)
    .header('cache-control', 'no-store')
    .send(wantsHtml ? PAGE : { error: 'locked', message: 'Postino is switched off by the Segretario kill switch. Write /riaccendi to the Telegram bot.' });
}
