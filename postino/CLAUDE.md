# Postino: notes for Claude

Postino is Ema's own email client (mail only). WhatsApp, calls and the Segretario live elsewhere.
Pull the latest `main` before changing anything: another session may have pushed.

## UI and UX rules (Ema asked for these explicitly)

- The phone inbox follows the Gmail Android app, measured from screenshots on Ema's phone
  (see the "Phone: the Gmail Android app" block at the end of `web/src/styles/gmail.css`).
  Keep it that way: rows are 89 px cards, 40 px avatar, 14 px sender, 11.5 px subject and preview.
- A new block in the list never takes more than one row by default. Anything with several items
  is a collapsed line like Groups (`bundle groups-row`), with a one-line summary, and opens on tap.
- Prefer a chip on the email's row (like Gmail's "Track package") over a new section.
- Before pushing a visible change, screenshot the mock app (`VITE_MOCK=1 npx vite`) at phone
  scale (532 px wide, dark and light) and look at the whole first screen: what does Ema see
  above the first email? Compare with Gmail when there is a Gmail equivalent.
- English UI text, short. No new settings when a sensible default works.

## Privacy

The repository is public. Never put real email content, order numbers, ticket codes, routes,
names or addresses in tests, mock data or commit messages: make the data up.

## Claude API inside Postino

Only for: the Spam? button and AI search (Opus 5.5), and marking new mail from people as
important / recognising brand deals (`server/src/triage.ts`, Haiku 5.5 by default, behind free
rule filters, 150 a day, switchable in Settings). Everything else uses rules, not Claude:
tell Ema what any new Claude use would cost before adding it.
