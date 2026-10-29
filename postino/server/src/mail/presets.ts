import dns from 'node:dns/promises';

export type ServerSettings = { host: string; port: number; secure: boolean };
export type Preset = { imap: ServerSettings; smtp: ServerSettings; username: string; note?: string };

const byDomain: Record<string, Omit<Preset, 'username'>> = {
  'gmail.com': {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Use an App Password (Google Account → Security → 2-Step Verification → App passwords).',
  },
  'googlemail.com': {
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    note: 'Use an App Password.',
  },
  'icloud.com': {
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    note: 'Use an app-specific password from appleid.apple.com.',
  },
  'me.com': { imap: { host: 'imap.mail.me.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.me.com', port: 587, secure: false } },
  'outlook.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, note: 'Microsoft accounts need OAuth; password login may be refused.' },
  'hotmail.com': { imap: { host: 'outlook.office365.com', port: 993, secure: true }, smtp: { host: 'smtp-mail.outlook.com', port: 587, secure: false }, note: 'Microsoft accounts need OAuth; password login may be refused.' },
  'yahoo.com': { imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true }, smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true }, note: 'Use an app password.' },
  'libero.it': { imap: { host: 'imapmail.libero.it', port: 993, secure: true }, smtp: { host: 'smtp.libero.it', port: 465, secure: true } },
  'virgilio.it': { imap: { host: 'in.virgilio.it', port: 993, secure: true }, smtp: { host: 'out.virgilio.it', port: 465, secure: true } },
  'tiscali.it': { imap: { host: 'imap.tiscali.it', port: 993, secure: true }, smtp: { host: 'smtp.tiscali.it', port: 465, secure: true } },
  'aruba.it': { imap: { host: 'imaps.aruba.it', port: 993, secure: true }, smtp: { host: 'smtps.aruba.it', port: 465, secure: true } },
  'pec.it': { imap: { host: 'imaps.pec.aruba.it', port: 993, secure: true }, smtp: { host: 'smtps.pec.aruba.it', port: 465, secure: true } },
  'fastmail.com': { imap: { host: 'imap.fastmail.com', port: 993, secure: true }, smtp: { host: 'smtp.fastmail.com', port: 465, secure: true } },
  'protonmail.com': { imap: { host: '127.0.0.1', port: 1143, secure: false }, smtp: { host: '127.0.0.1', port: 1025, secure: false }, note: 'Proton needs the Proton Mail Bridge.' },
  'zoho.com': { imap: { host: 'imap.zoho.com', port: 993, secure: true }, smtp: { host: 'smtp.zoho.com', port: 465, secure: true } },
  'zoho.eu': { imap: { host: 'imap.zoho.eu', port: 993, secure: true }, smtp: { host: 'smtp.zoho.eu', port: 465, secure: true } },
};

// Known vhosting (Italian host) servers: the same host serves IMAP and SMTP.
const vhostingHosts = ['mx1.vhostingcloud.com', 'mailserver11.vhosting-it.com', 'mailserver2.vhosting-it.com'];
// Domains whose mail server we already know (saves a DNS lookup and works offline).
const knownDomainHosts: Record<string, string> = {
  'emazamboni.com': 'mx1.vhostingcloud.com',
  'stostudio.it': 'mailserver11.vhosting-it.com',
  'emanuelezamboni.com': 'mailserver2.vhosting-it.com',
};

function fromMailHost(host: string): Omit<Preset, 'username'> {
  return { imap: { host, port: 993, secure: true }, smtp: { host, port: 465, secure: true } };
}

/**
 * Guess server settings for an address: known providers first, then the
 * domain's MX record (vhosting and most small hosts answer IMAP/SMTP on the MX
 * host itself), then mail./imap./smtp. subdomains.
 */
export async function guessPreset(email: string): Promise<Preset | null> {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return null;
  if (byDomain[domain]) return { ...byDomain[domain], username: email };
  if (knownDomainHosts[domain]) return { ...fromMailHost(knownDomainHosts[domain]), username: email, note: 'vhosting: the user name is the full address.' };
  let mx: string | null = null;
  try {
    const records = await dns.resolveMx(domain);
    records.sort((a, b) => a.priority - b.priority);
    mx = records[0]?.exchange?.replace(/\.$/, '') || null;
  } catch {
    mx = null;
  }
  if (mx && (vhostingHosts.includes(mx) || /vhosting/i.test(mx))) {
    return { ...fromMailHost(mx), username: email, note: 'vhosting: the user name is the full address.' };
  }
  if (mx && /\b(google|googlemail)\.com$/i.test(mx)) {
    return { ...byDomain['gmail.com'], username: email, note: 'Google Workspace: use an App Password.' };
  }
  if (mx && /outlook\.com$/i.test(mx)) {
    return { ...byDomain['outlook.com'], username: email };
  }
  if (mx) return { ...fromMailHost(mx), username: email, note: 'Guessed from the domain\'s mail server; adjust if the connection test fails.' };
  return {
    imap: { host: `mail.${domain}`, port: 993, secure: true },
    smtp: { host: `mail.${domain}`, port: 465, secure: true },
    username: email,
    note: 'Guessed; check the host names with your provider.',
  };
}
