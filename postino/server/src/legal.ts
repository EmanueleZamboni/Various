import type { FastifyInstance } from 'fastify';

/**
 * Public privacy policy and terms (needed to publish the Google OAuth app). Plain HTML,
 * served by the server itself: no login, and the web app's setup wizard never sees these routes.
 */

const UPDATED = '31 October 2026';
const CONTACT = 'ezamboni96@gmail.com';

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Postino</title>
<style>
  body{margin:0;background:#f6f8fc;color:#1f1f1f;font:16px/1.6 Arial,Helvetica,sans-serif}
  main{max-width:720px;margin:32px auto;padding:32px 28px;background:#fff;border-radius:16px}
  h1{font-size:28px;font-weight:400;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px}
  .muted{color:#5f6368;font-size:14px}a{color:#0b57d0}ul{padding-left:22px}
  @media(max-width:760px){main{margin:0;border-radius:0;padding:24px 18px}}
</style></head>
<body><main>${body}
<p class="muted" style="margin-top:32px"><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a> · Contact: <a href="mailto:${CONTACT}">${CONTACT}</a></p>
</main></body></html>`;

const PRIVACY = page(
  'Privacy policy',
  `<h1>Postino privacy policy</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>Postino is a private, self-hosted email client run by Emanuele Zamboni for his own personal use. It is not a public service and has no other users.</p>
<h2>Google data Postino accesses</h2>
<ul>
  <li><b>Gmail</b> (through IMAP and SMTP): to read, organise and send the user's own email.</li>
  <li><b>Google Drive</b>: only the files Postino itself saves (attachments the user chooses to save or open in Google Docs, Sheets or Slides).</li>
  <li><b>Google Calendar</b>: to add events from invitations and answer them, and to check whether the user is free at that time.</li>
  <li><b>Google Contacts</b> (People API): names, email addresses and photos, to suggest recipients and show sender pictures.</li>
  <li><b>Google Tasks</b>: to create tasks from emails and show the user's task list.</li>
</ul>
<h2>How it is used</h2>
<p>This data is used only to show and manage the user's own data inside Postino. Nothing else is done with it.</p>
<h2>Where it is stored</h2>
<p>Everything is stored only on the user's own server (Oracle Cloud, European Union). Mailbox passwords and Google tokens are stored encrypted.</p>
<h2>Sharing</h2>
<p>Google user data is not sold, not shared with third parties, not used for advertising and not used to train AI or machine-learning models.</p>
<p>Postino's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>
<h2>Your control</h2>
<p>Access can be revoked at any time at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Disconnecting Google in Postino's settings also deletes the stored Google tokens.</p>
<h2>Contact</h2>
<p><a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
);

const TERMS = page(
  'Terms',
  `<h1>Postino terms of use</h1>
<p class="muted">Last updated ${UPDATED}</p>
<p>Postino is a private, self-hosted email client run by Emanuele Zamboni for his own personal use. It is not offered to the public.</p>
<p>It is provided as is, without warranty. The person running it is responsible for their own server, accounts and data.</p>
<p>How Google user data is handled is described in the <a href="/privacy">privacy policy</a>.</p>
<p>Questions: <a href="mailto:${CONTACT}">${CONTACT}</a></p>`,
);

export function registerLegalRoutes(app: FastifyInstance): void {
  for (const [url, html] of [['/privacy', PRIVACY], ['/terms', TERMS]] as const) {
    app.get(url, async (_req, reply) => {
      reply.header('Cache-Control', 'public, max-age=3600');
      return reply.type('text/html; charset=utf-8').send(html);
    });
  }
}
