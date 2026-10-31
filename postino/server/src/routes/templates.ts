import type { FastifyInstance } from 'fastify';
import { db, getSetting, setSetting } from '../db.js';

/**
 * Email templates ("modelli"): reusable subject + text, inserted into a new email
 * or a reply. {nome} / {name} become the first name of the first recipient.
 */
type TemplateRow = { id: number; name: string; subject: string; text: string; sort_order: number; updated_at: string };
const view = (t: TemplateRow) => ({ id: String(t.id), name: t.name, subject: t.subject, text: t.text, updatedAt: t.updated_at });

const STARTERS: { name: string; subject: string; text: string }[] = [
  { name: 'Preventivo', subject: 'Preventivo', text: 'Ciao {nome},\n\ngrazie per la richiesta. In allegato trovi il preventivo per quanto discusso.\n\nResto a disposizione per qualsiasi domanda o modifica.\n\nUn saluto,' },
  { name: 'Disponibilità date', subject: 'Disponibilità', text: 'Ciao {nome},\n\nsono disponibile nelle seguenti date:\n- \n- \n\nFammi sapere quale preferisci e blocco la giornata.\n\nGrazie,' },
  { name: 'Invio materiale', subject: 'Materiale', text: 'Ciao {nome},\n\nti invio il materiale come d\'accordo. Lo trovi qui: \n\nSe hai bisogno di altro dimmi pure.\n\nA presto,' },
  { name: 'Sollecito gentile', subject: 'Re: ', text: 'Ciao {nome},\n\nti scrivo per un aggiornamento sulla mail precedente. Quando hai un momento fammi sapere.\n\nGrazie mille,' },
  { name: 'Grazie', subject: 'Grazie', text: 'Ciao {nome},\n\ngrazie ancora per la collaborazione, è stato un piacere lavorare insieme.\n\nA presto,' },
];

function seedOnce(): void {
  if (getSetting<boolean>('templates.seeded', false)) return;
  const ins = db.prepare('INSERT INTO templates(name, subject, text, sort_order) VALUES (?, ?, ?, ?)');
  STARTERS.forEach((t, i) => ins.run(t.name, t.subject, t.text, i));
  setSetting('templates.seeded', true);
}

function clean(b: Record<string, unknown> | undefined) {
  const name = String(b?.name ?? '').trim().slice(0, 80);
  const subject = String(b?.subject ?? '').slice(0, 300);
  const text = String(b?.text ?? '').slice(0, 20_000);
  return { name, subject, text };
}

export function registerTemplateRoutes(app: FastifyInstance): void {
  seedOnce();
  app.get('/api/templates', async () => (db.prepare('SELECT * FROM templates ORDER BY sort_order, id').all() as TemplateRow[]).map(view));
  app.post<{ Body: Record<string, unknown> }>('/api/templates', async (req, reply) => {
    const t = clean(req.body);
    if (!t.name) return reply.code(400).send({ error: 'invalid', message: 'Give the template a name.' });
    const order = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM templates').get() as { n: number }).n;
    const info = db.prepare('INSERT INTO templates(name, subject, text, sort_order) VALUES (?, ?, ?, ?)').run(t.name, t.subject, t.text, order);
    return reply.code(201).send(view(db.prepare('SELECT * FROM templates WHERE id = ?').get(info.lastInsertRowid) as TemplateRow));
  });
  app.put<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/templates/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM templates WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    const t = clean(req.body);
    if (!t.name) return reply.code(400).send({ error: 'invalid', message: 'Give the template a name.' });
    db.prepare("UPDATE templates SET name = ?, subject = ?, text = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(t.name, t.subject, t.text, id);
    return view(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
  });
  app.delete<{ Params: { id: string } }>('/api/templates/:id', async (req, reply) => {
    db.prepare('DELETE FROM templates WHERE id = ?').run(Number(req.params.id));
    return reply.code(204).send();
  });
}
