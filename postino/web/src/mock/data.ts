import type { Account, Address, Attachment, Category, Draft, Folder, FolderRole, Message, Settings } from '../api/types';

// In-memory state for mock mode. Realistic for a videomaker / YouTube creator in Italy.

export const ME: Record<string, Address> = {};

export const accounts: Account[] = [
  { id: 'a1', email: 'collab@emazamboni.com', name: 'Emanuele Zamboni (@emazamboni)', color: '#3B6FE0', order: 0, signature: 'Ema Zamboni\nyoutube.com/@emazamboni', status: 'connected', error: null, unread: 0, initialSync: { done: true, fetched: 1298, total: 1298 } },
  { id: 'a2', email: 'info@emazamboni.com', name: 'Emanuele Zamboni', color: '#D9486B', order: 1, signature: '', status: 'connected', error: null, unread: 0, initialSync: { done: true, fetched: 412, total: 412 } },
  { id: 'a3', email: 'admin@emazamboni.com', name: 'Emanuele Zamboni', color: '#2E9E6B', order: 2, signature: '', status: 'connected', error: null, unread: 0, initialSync: { done: true, fetched: 88, total: 88 } },
  { id: 'a4', email: 'emanuele.zamboni@stostudio.it', name: 'Emanuele Zamboni | STOSTUDIO', color: '#8A5BD6', order: 3, signature: 'Emanuele Zamboni\nSTOSTUDIO · stostudio.it', status: 'connected', error: null, unread: 0, initialSync: { done: true, fetched: 66, total: 66 } },
  { id: 'a5', email: 'info@stostudio.it', name: 'STOSTUDIO', color: '#E07C2A', order: 4, signature: '', status: 'syncing', error: null, unread: 0, initialSync: { done: false, fetched: 140, total: 530 } },
  { id: 'a6', email: 'admin@stostudio.it', name: 'STOSTUDIO', color: '#1AA3B5', order: 5, signature: '', status: 'connected', error: null, unread: 0, initialSync: { done: true, fetched: 23, total: 23 } },
  { id: 'a7', email: 'info@emanuelezamboni.com', name: 'Emanuele Zamboni', color: '#9A8A1E', order: 6, signature: '', status: 'error', error: 'IMAP login failed: authentication rejected by mailserver2.vhosting-it.com', unread: 0, initialSync: { done: true, fetched: 310, total: 310 } },
];
for (const a of accounts) ME[a.id] = { name: a.name, email: a.email };

export const folders: Folder[] = [];
const roleNames: [string, FolderRole][] = [
  ['INBOX', 'inbox'],
  ['Sent', 'sent'],
  ['Drafts', 'drafts'],
  ['Archive', 'archive'],
  ['Junk', 'junk'],
  ['INBOX.spam', 'junk'],
  ['Trash', 'trash'],
  ['Blocked', 'blocked'],
];
for (const a of accounts) {
  for (const [path, role] of roleNames) {
    if (role === 'archive' && a.email.endsWith('stostudio.it')) continue;
    folders.push({ id: `${a.id}:${path}`, accountId: a.id, path, name: path === 'INBOX' ? 'Inbox' : path === 'INBOX.spam' ? 'Spam (server)' : path, role, unread: 0, total: 0 });
  }
}
export const folderByRole = (accountId: string, role: FolderRole): Folder => {
  const found = folders.find((f) => f.accountId === accountId && f.role === role);
  if (found) return found;
  // Like the real server: Archive and Blocked are created on the mail server the first time they are needed.
  if (role === 'archive' || role === 'blocked') {
    const path = role === 'archive' ? 'Archive' : 'Blocked';
    const f: Folder = { id: `${accountId}:${path}`, accountId, path, name: path, role, unread: 0, total: 0 };
    folders.push(f);
    return f;
  }
  return folders.find((f) => f.accountId === accountId && f.role === 'inbox')!;
};

export type MockMessage = Message & { rawHtml?: string };
export type MockThread = { id: string; accountId: string; messages: MockMessage[] };

export const threads: MockThread[] = [];
export const blocked: { id: string; pattern: string; note: string; createdAt: string; count: number }[] = [
  { id: 'b1', pattern: 'iscreenofficial@gmail.com', note: 'Paid cooperation spam', createdAt: daysAgo(78), count: 3 },
  { id: 'b2', pattern: '@flashdeals.biz', note: '', createdAt: daysAgo(30), count: 11 },
];
export const drafts: Draft[] = [];
export const settings: Settings = {
  notifications: { enabled: false, categories: ['person'], sound: true },
  inbox: { smart: false, groupNotifications: true, groupNewsletters: true, previewLines: 1, showAvatars: true, showAccountTag: true, pinnedOnTop: true },
  reading: { markRead: 'open', markReadDelay: 2, remoteImages: 'ask', afterAction: 'next', confirmDelete: false, showQuoted: false },
  compose: { defaultAccount: 'lastUsed', replyFromRecipient: true, defaultReply: 'reply', includeQuote: true, undoSendSec: 10, sendAndArchive: false, bccMyself: false, confirmNoSubject: true },
  swipe: { left: 'archive', right: 'pin' },
  appearance: { density: 'comfortable', textSize: 'normal', readingPane: 'full' },
  smartInbox: true,
  signaturePerAccount: true,
};
export let needsSetup = false;
export let loggedIn = true;
export const setAuth = (setup: boolean, login: boolean) => {
  needsSetup = setup;
  loggedIn = login;
};

let seq = 0;
const nid = (p: string) => `${p}${(++seq).toString(36)}`;

function daysAgo(d: number, h = 10, m = 0): string {
  const x = new Date();
  x.setDate(x.getDate() - d);
  x.setHours(h, m, 0, 0);
  return x.toISOString();
}
function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60000).toISOString();
}

const P = (name: string, email: string): Address => ({ name, email });

const att = (filename: string, size: number, contentType: string): Attachment => {
  const id = nid('att');
  return { id, filename, contentType, size, inline: false, url: `/api/attachments/${id}` };
};

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

type MsgSpec = {
  from: Address | 'me';
  to?: Address[];
  cc?: Address[];
  date: string;
  text: string;
  html?: string;
  remote?: boolean;
  att?: Attachment[];
  seen?: boolean;
  flagged?: boolean;
  quoted?: string;
  unsub?: string | null;
};

function addThread(opts: { accountId: string; subject: string; category?: Category; role?: FolderRole; msgs: MsgSpec[] }) {
  const tid = nid('t');
  const account = accounts.find((a) => a.id === opts.accountId)!;
  const me = ME[opts.accountId];
  const msgs: MockMessage[] = opts.msgs.map((m, i) => {
    const mine = m.from === 'me';
    const from: Address = m.from === 'me' ? me : m.from;
    const role: FolderRole = opts.role ?? (mine ? 'sent' : 'inbox');
    const folder = folderByRole(opts.accountId, role);
    const paragraphs = m.text.split(/\n\n+/);
    const html = m.html ?? `<div>${paragraphs.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
    const id = nid('m');
    return {
      id,
      threadId: tid,
      accountId: opts.accountId,
      folderId: folder.id,
      folderRole: role,
      messageId: `<${id}@mock.postino>`,
      from,
      to: m.to ?? (mine ? [opts.msgs.find((x) => x.from !== 'me')?.from as Address ?? me] : [me]),
      cc: m.cc ?? [],
      bcc: [],
      replyTo: [],
      subject: i === 0 ? opts.subject : opts.subject.startsWith('Re:') ? opts.subject : `Re: ${opts.subject}`,
      date: m.date,
      seen: m.seen ?? (mine ? true : i < opts.msgs.length - 1),
      flagged: m.flagged ?? false,
      answered: false,
      draft: role === 'drafts',
      mine,
      category: mine ? 'person' : opts.category ?? 'person',
      snippet: paragraphs[0].slice(0, 160),
      attachments: m.att ?? [],
      listUnsubscribe: m.unsub ?? (opts.category === 'newsletter' ? `https://example.com/unsubscribe?u=${account.id}` : null),
      body: { html, text: m.text, hasRemoteImages: !!m.remote, quoted: m.quoted ?? null, fetched: true },
    };
  });
  threads.push({ id: tid, accountId: opts.accountId, messages: msgs });
  return tid;
}

// ---------- People threads ----------
const anna = P('Anna Vialetto', 'anna.v@netstrategy.it');
const valentin = P('Valentin Ipuche', 'valentin.i@netstrategy.it');
const ivan = P('Ivan Mariani', 'ivan.mariani@livingmedia.it');
const sagliocco = P('Studio Sagliocco', 'sagliocco.studio@gmail.com');
const christina = P('Christina (Thinborne)', 'christina.thinborne@gmail.com');
const claire = P('Claire · KAIBOER', 'us@kaiboer.com');
const dario = P('Dario Valastro', 'dario.valastro@gmail.com');
const marta = P('Marta Benassi', 'marta@benassicomunicazione.it');
const luca = P('Luca Ferrarini', 'luca.ferrarini@gmail.com');
const giulia = P('Giulia Rossetti', 'g.rossetti@comune.modena.it');

addThread({
  accountId: 'a4',
  subject: 'ISUZU Shooting // organizzazione giornate di riprese',
  msgs: [
    { from: anna, date: daysAgo(9, 16, 58), text: 'Ciao Emanuele,\n\ncome anticipato al telefono, il cliente conferma le giornate di riprese del 4 e 5 novembre presso la concessionaria di Modena. Serve un team ridotto: tu, un operatore e un fonico.\n\nTi allego il brief aggiornato con le inquadrature richieste per il D-MAX. Fammi sapere se la timeline ti torna.\n\nA presto,\nAnna', att: [att('Brief_ISUZU_riprese_v3.pdf', 1_840_000, 'application/pdf')] },
    { from: 'me', date: daysAgo(8, 8, 50), text: 'Ciao Anna,\n\nperfetto per il 4 e 5. Per il fonico confermo Matteo. Una domanda: il drone lo portiamo? Nel brief c’è un’inquadratura aerea ma non so se avete il permesso per l’area della concessionaria.\n\nEmanuele' },
    { from: anna, date: daysAgo(8, 10, 3), text: 'Il drone sì, il cliente ha già il nulla osta per il piazzale (allegato). Ti chiedo solo di mandarmi la lista attrezzatura entro domani per l’assicurazione.' , att: [att('NullaOsta_piazzale.pdf', 420_000, 'application/pdf')] },
    { from: anna, date: daysAgo(8, 10, 22), text: 'Dimenticavo: call con il cliente giovedì alle 11 per ultimi dettagli. Ti mando l’invito.', seen: false },
  ],
});
addThread({
  accountId: 'a4',
  subject: 'Re: Video Bilanciai',
  msgs: [
    { from: 'me', date: daysAgo(10, 15, 0), text: 'Ciao Valentin,\n\nti mando il primo montaggio del video Bilanciai. È ancora senza color e senza musica definitiva, ma la struttura è quella.\n\nLink: https://frame.io/r/bilanciai-v1\n\nEmanuele' },
    { from: valentin, date: daysAgo(7, 9, 57), text: 'Ciao Emanuele,\n\nvisto con il cliente. Piace molto. Due note:\n\n1. Al minuto 1:12 il logo rimane troppo poco, chiedono 2 secondi in più.\n2. La voce fuori campo nella parte finale va riregistrata, c’è un rumore di fondo.\n\nPer il resto ok. Quando pensi di avere la v2?\n\nValentin', seen: false, quoted: 'Il 20 ott 2026, Emanuele Zamboni ha scritto:\n> ti mando il primo montaggio del video Bilanciai.' },
  ],
});
addThread({
  accountId: 'a4',
  subject: 'REDDITI + F24 + ALTRE DICHIARAZIONI',
  msgs: [
    { from: sagliocco, date: daysAgo(1, 18, 0), text: 'Buonasera Emanuele,\n\nin allegato trova il modello Redditi 2026, gli F24 per il saldo e primo acconto in scadenza il 30 novembre e la dichiarazione IVA trimestrale.\n\nLa prego di confermarmi la ricezione e di procedere ai pagamenti entro la scadenza.\n\nCordiali saluti,\nStudio Sagliocco', att: [att('Redditi_2026_Zamboni.pdf', 2_310_000, 'application/pdf'), att('F24_saldo_acconto.pdf', 96_000, 'application/pdf'), att('IVA_3trim_2026.pdf', 210_000, 'application/pdf')], seen: false },
  ],
});
addThread({
  accountId: 'a4',
  subject: 'Saie Bologna 2026 - pass & info',
  msgs: [
    { from: ivan, date: daysAgo(23, 20, 48), text: 'Ciao Emanuele,\n\nti confermo i pass per SAIE: ingresso stampa, padiglione 30, dal 22 al 25 ottobre. In allegato il foglio con le interviste programmate, aggiornalo pure se cambia qualcosa.\n\nCi vediamo in fiera!\nIvan', att: [att('SAIE_B_2026_Interviste.xlsx', 44_000, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')] },
    { from: 'me', date: daysAgo(22, 9, 15), text: 'Grazie Ivan, tutto chiaro. Porto anche il secondo operatore per le interviste in parallelo.' },
  ],
});
addThread({
  accountId: 'a1',
  subject: 'Re: Collaboration Opportunity — Thinborne × Ema Zamboni',
  msgs: [
    { from: christina, date: daysAgo(12, 11, 0), text: 'Hi Ema,\n\nI’m Christina from Thinborne. We make ultra-thin aramid cases and we love your retro tech reviews. Would you be open to a paid dedicated video? Budget is flexible for the right fit.\n\nBest,\nChristina' },
    { from: 'me', date: daysAgo(11, 10, 30), text: 'Hi Christina,\n\nthanks for reaching out. My rate card is attached. A dedicated video starts at €1,800 and includes one round of revisions. Let me know if that works for your budget.\n\nEma', att: [att('EmaZamboni_RateCard_2026.pdf', 640_000, 'application/pdf')] },
    { from: christina, date: daysAgo(2, 13, 51), text: 'Thanks Ema! €1,800 works. Could we schedule the video for the second week of November, before our Black Friday push? I can ship the samples this week if you send me an address.', seen: false },
  ],
});
addThread({
  accountId: 'a1',
  subject: 'KAIBOER × Ema Zamboni — DMP-K8 PRO review enquiry',
  msgs: [
    { from: claire, date: daysAgo(1, 9, 9), text: 'Dear Ema,\n\nWe are KAIBOER, a media player brand. We would like to send you the DMP-K8 PRO for a review. The unit is yours to keep. Let us know if you are interested and we will arrange the shipment.\n\nClaire', seen: false },
  ],
});
addThread({
  accountId: 'a1',
  subject: 'A TikTok idea for “Portasound Rush”',
  msgs: [
    { from: P('Pavel T.', 'crazyshmelev1@gmail.com'), date: daysAgo(2, 11, 52), text: 'Hi Ema! Huge fan here. I had an idea for a short on the Portasound: a split-screen “1985 vs 2026” synth jam. Happy to send you a sketch of the beat if you are curious. No strings attached.\n\nPavel', seen: true },
  ],
});
addThread({
  accountId: 'a2',
  subject: 'Preventivo video matrimonio 14 giugno',
  msgs: [
    { from: luca, date: daysAgo(4, 21, 12), text: 'Buonasera,\n\nci sposiamo il 14 giugno a Castelvetro e cercavamo un videomaker con uno stile cinematografico, non il classico video da matrimonio. Abbiamo visto i vostri lavori e ci piacerebbe avere un preventivo per la giornata intera.\n\nGrazie,\nLuca e Sara' },
    { from: 'me', date: daysAgo(3, 10, 5), text: 'Buongiorno Luca e Sara,\n\ngrazie per avermi scritto. Allego il listino con le tre formule. Per il 14 giugno sono ancora libero: se vi va, facciamo una call di 20 minuti la prossima settimana per capire cosa avete in mente.\n\nEmanuele', att: [att('Listino_Wedding_2027.pdf', 1_120_000, 'application/pdf')] },
    { from: luca, date: daysAgo(0, 8, 40), text: 'Perfetto, la formula “Racconto” è quella che fa per noi. Martedì alle 18 per la call va bene?', seen: false },
  ],
});
addThread({
  accountId: 'a5',
  subject: 'Richiesta disponibilità riprese evento 15 novembre',
  msgs: [
    { from: giulia, date: daysAgo(0, 9, 5), text: 'Gentile STOSTUDIO,\n\nil Comune di Modena organizza il 15 novembre una serata al Teatro Storchi e avremmo bisogno di una ripresa a due camere con consegna di un video riassuntivo di 3 minuti entro il 20.\n\nPotreste inviarci un preventivo entro venerdì?\n\nCordiali saluti,\nGiulia Rossetti\nUfficio Cultura', seen: false },
  ],
});
addThread({
  accountId: 'a5',
  subject: 'Materiali per il sito: foto studio',
  msgs: [
    { from: marta, date: daysAgo(5, 14, 30), text: 'Ciao ragazzi,\n\nper la pagina “Chi siamo” mi servono 4-5 foto dello studio in orizzontale, almeno 2000 px. Le avete già o devo passare io a farle?\n\nMarta' },
    { from: 'me', date: daysAgo(5, 16, 2), text: 'Ciao Marta, le abbiamo. Te le carico su Drive entro stasera.' },
    { from: marta, date: daysAgo(4, 9, 0), text: 'Ricevute, grazie! Sono perfette.' },
  ],
});
addThread({
  accountId: 'a1',
  subject: 'Pinned: Shipping address for samples',
  msgs: [
    { from: P('Yvonne (JPfans)', 'yvonne@jpfans.net'), date: daysAgo(3, 15, 10), text: 'Hi Ema, the retro handheld samples ship Monday. Please confirm the address and a phone number for the courier.', flagged: true, seen: true },
  ],
});
addThread({
  accountId: 'a2',
  subject: 'Contratto cessione diritti — bozza',
  msgs: [
    { from: P('Avv. Daniele Corsini', 'd.corsini@corsinilegal.it'), date: daysAgo(15, 12, 15), text: 'Gentile Emanuele,\n\ncome richiesto, allego la bozza del contratto di cessione dei diritti per i video prodotti per Netstrategy. Ho inserito la clausola di esclusiva limitata a 24 mesi come concordato.\n\nResto a disposizione.\nDaniele Corsini', att: [att('Contratto_cessione_v2.docx', 96_000, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')], flagged: true },
  ],
});

// ---------- Notifications ----------
const drive = P('Dario Valastro (via Google Drive)', 'drive-shares-dm-noreply@google.com');
addThread({ accountId: 'a4', category: 'notification', subject: 'Folder shared with you: "NEW Vettorializzato"', msgs: [{ from: drive, date: daysAgo(0, 7, 18), text: 'Dario Valastro (dario.valastro@gmail.com) has shared the following folder:\n\nNEW Vettorializzato\n\nOpen in Drive: https://drive.google.com/drive/folders/1xyz', remote: true, html: '<div style="font-family:Arial,sans-serif;color:#222"><p>Dario Valastro (dario.valastro@gmail.com) has shared the following folder:</p><p style="font-size:18px"><b>NEW Vettorializzato</b></p><p><a href="https://drive.google.com/drive/folders/1xyz">Open in Drive</a></p><img data-remote-src="https://www.gstatic.com/images/branding/product/2x/drive_2020q4_48dp.png" src="" width="48" height="48" alt="Google Drive"></div>', seen: false }] });
addThread({ accountId: 'a4', category: 'notification', subject: 'Spreadsheet shared with you: "SAIE B 2026 - Videomaker"', msgs: [{ from: P('Ivan Mariani (via Google Sheets)', 'drive-shares-dm-noreply@google.com'), date: daysAgo(22, 18, 45), text: 'Ivan Mariani has shared a spreadsheet with you: SAIE B 2026 - Videomaker.', remote: true }] });
addThread({ accountId: 'a1', category: 'notification', subject: 'Your parcel DHL 4471 0021 is out for delivery', msgs: [{ from: P('DHL Express', 'noreply@dhl.com'), date: minutesAgo(45), text: 'Your shipment from Shenzhen is out for delivery today between 13:00 and 17:00. Track: https://dhl.com/track/44710021', seen: false, remote: true }] });
addThread({ accountId: 'a2', category: 'notification', subject: 'Fattura elettronica ricevuta: Aruba S.p.A.', msgs: [{ from: P('Aruba Fatturazione', 'noreply@fatturazione.aruba.it'), date: daysAgo(1, 6, 0), text: 'È disponibile una nuova fattura elettronica ricevuta da Aruba S.p.A. per € 24,40. Accedi al portale per visualizzarla.', seen: false }] });
addThread({ accountId: 'a3', category: 'notification', subject: 'Il dominio emazamboni.com si rinnova tra 30 giorni', msgs: [{ from: P('VHosting', 'billing@vhosting.it'), date: daysAgo(2, 8, 0), text: 'Gentile cliente, il dominio emazamboni.com e le caselle associate si rinnoveranno automaticamente il 28 novembre. Nessuna azione richiesta.' }] });
addThread({ accountId: 'a1', category: 'notification', subject: 'Payment received: $420.00 from Thinborne Ltd', msgs: [{ from: P('PayPal', 'service@paypal.com'), date: daysAgo(6, 17, 22), text: 'You received a payment of $420.00 USD from Thinborne Ltd. Transaction ID 8XK22914.' , remote: true }] });
addThread({ accountId: 'a6', category: 'notification', subject: 'Backup completato: stostudio-nas', msgs: [{ from: P('Synology DSM', 'admin@stostudio.it'), date: daysAgo(0, 3, 0), text: 'Hyper Backup task "Progetti 2026" completed successfully. 1.4 TB protected.' }] });

// ---------- Newsletters / pitches ----------
addThread({ accountId: 'a1', category: 'newsletter', subject: '🎶 Hi Ema Zamboni × Freebeat AI: Invitation to Paid Partners Program', msgs: [{ from: P('Israel from Freebeat AI', 'ipolymbah@freebeat.ai'), date: daysAgo(2, 5, 13), text: 'Hi Ema,\n\nWe love your channel. Freebeat AI turns any text into a music video. Join our paid partners program: $500 per dedicated video plus affiliate revenue.\n\nReply to this email to get started.', seen: false, remote: true }] });
addThread({ accountId: 'a1', category: 'newsletter', subject: 'UGREEN Long-Term Collaboration Invitation | YouTube Video Review Partnership', msgs: [{ from: P('Lovis (NoxInfluencer)', 'lovis@mcn.noxinfluencer.com'), date: daysAgo(2, 9, 43), text: 'Dear Ema Zamboni,\n\nUGREEN is looking for long-term review partners with a stable budget. We offer free products and a fee per video. Please reply with your rate card.' }] });
addThread({ accountId: 'a1', category: 'newsletter', subject: 'Would you make a Reel for $2,000? #PredisReelRush', msgs: [{ from: P('Rasika from Predis.ai', 'hello@predis.ai'), date: daysAgo(1, 12, 50), text: 'We are running a creator contest. Make a Reel about Predis.ai and the best one gets $2,000.', seen: false, remote: true }] });
addThread({ accountId: 'a1', category: 'newsletter', subject: 'Paid Collaboration Invitation from Pippit 🌟', msgs: [{ from: P('Joy Qiao', '10amcollab@gmail.com'), date: daysAgo(2, 17, 45), text: 'Hi Ema, Pippit (by CapCut) wants to sponsor an integration in your next video. Budget: $800. Interested?' }] });
addThread({ accountId: 'a1', category: 'newsletter', subject: 'Experience XGIMI’s latest AURA 3 series with VIVIDSTORM in NYC', msgs: [{ from: P('VIVIDSTORM', 'support@vividstormscreen.com'), date: daysAgo(0, 12, 11), text: 'Join us at CES Unveiled NYC for a hands-on with the AURA 3 ultra-short-throw projector and our ALR screens.', remote: true, seen: false }] });
addThread({ accountId: 'a2', category: 'newsletter', subject: 'Frame.io weekly: new review links, better comments', msgs: [{ from: P('Frame.io', 'news@frame.io'), date: daysAgo(3, 8, 0), text: 'This week: review links with expiry dates, comment threads per clip, and a faster transfer app for macOS.', remote: true }] });
addThread({ accountId: 'a4', category: 'newsletter', subject: 'Blackmagic Design: DaVinci Resolve 20.2 is here', msgs: [{ from: P('Blackmagic Design', 'news@blackmagicdesign.com'), date: daysAgo(4, 10, 0), text: 'DaVinci Resolve 20.2 adds AI dialogue separation, a new Fusion particle system and improved multicam.', remote: true }] });
addThread({ accountId: 'a7', category: 'newsletter', subject: 'Teaming up inquiry', msgs: [{ from: P('wiktoriamazur80@wp.pl', 'wiktoriamazur80@wp.pl'), date: daysAgo(1, 21, 2), text: 'Hello, I represent a brand of phone accessories and we want to team up with you. Please reply for details.' }] });

// ---------- Other folders ----------
addThread({ accountId: 'a1', role: 'junk', subject: 'Your account will be suspended', msgs: [{ from: P('Security Team', 'alert@acc0unt-verify.biz'), date: daysAgo(2, 3, 12), text: 'Verify your password now or lose access to your mailbox.' }] });
addThread({ accountId: 'a2', role: 'junk', subject: 'Congratulazioni! Hai vinto un buono da €500', msgs: [{ from: P('Premi Online', 'winner@claim-prize-now.biz'), date: daysAgo(1, 4, 30), text: 'Conferma i tuoi dati entro 24 ore per ricevere il premio.' }] });
addThread({ accountId: 'a1', role: 'blocked', subject: 'Ema Zamboni Tiktok/Ins — iScreen New Paid Cooperation Offer', msgs: [{ from: P('iScreen', 'iscreenofficial@gmail.com'), date: daysAgo(3, 6, 56), text: 'We are iScreen, a brand of portable monitors. Paid cooperation available.' }] });
addThread({ accountId: 'a1', role: 'archive', subject: 'Invoice #2026-031 — Thinborne', msgs: [{ from: 'me', to: [christina], date: daysAgo(20, 10, 0), text: 'Hi Christina, invoice attached for the September integration. Payment within 30 days.', att: [att('Invoice_2026-031.pdf', 110_000, 'application/pdf')] }], });
addThread({ accountId: 'a4', role: 'archive', subject: 'Re: Consegna video Bilanciai v0', msgs: [{ from: valentin, date: daysAgo(30, 11, 0), text: 'Ricevuto, grazie. Lo mostro al cliente lunedì.' }] });
addThread({ accountId: 'a2', role: 'trash', subject: 'Offerta speciale hosting -50%', msgs: [{ from: P('HostDeal', 'promo@hostdeal.example'), date: daysAgo(8, 7, 0), text: 'Solo per oggi: hosting WordPress a metà prezzo.' }] });
addThread({ accountId: 'a4', role: 'sent', subject: 'Re: Quote for the Monti apartment video', msgs: [{ from: 'me', to: [P('Paolo Monti', 'paolo.monti@gmail.com')], date: daysAgo(1, 18, 10), text: 'Hi Paolo, attached is the quote for the real-estate video we discussed. Happy to walk you through it on a call.', att: [att('Preventivo_Monti.pdf', 210_000, 'application/pdf')] }] });
addThread({ accountId: 'a2', role: 'drafts', subject: 'Proposta collaborazione Comune di Castelvetro', msgs: [{ from: 'me', to: [P('Ufficio Cultura Castelvetro', 'cultura@comune.castelvetro.mo.it')], date: daysAgo(2, 21, 30), text: 'Buongiorno,\n\nvi scrivo per proporvi una serie di brevi video sui borghi del territorio' }] });

export function recount() {
  for (const f of folders) {
    const ms = threads.flatMap((t) => t.messages).filter((m) => m.folderId === f.id);
    f.total = ms.length;
    f.unread = ms.filter((m) => !m.seen).length;
  }
  for (const a of accounts) {
    a.unread = threads
      .filter((t) => t.accountId === a.id)
      .filter((t) => t.messages.some((m) => m.folderRole === 'inbox' && !m.seen)).length;
  }
}
recount();
