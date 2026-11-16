import { describe, it, expect } from 'vitest';
import { isDmarcReport } from './sync.js';

describe('DMARC aggregate reports', () => {
  it('recognises the reports, never delivery failures', () => {
    expect(isDmarcReport('noreply-dmarc-support@google.com', 'Report domain: example.com Submitter: google.com Report-ID: 123')).toBe(true);
    expect(isDmarcReport('dmarcreport@microsoft.com', '[Preview] Report Domain: example.com Submitter: enterprise.protection.outlook.com Report-ID: abc')).toBe(true);
    expect(isDmarcReport('postmaster@amazonses.com', 'Dmarc Aggregate Report Domain: {example.com} Submitter: {Amazon SES}')).toBe(true);
    expect(isDmarcReport('noreply-dmarc@zoho.com', 'Report domain: example.com Submitter: zohomail.com')).toBe(true);
    expect(isDmarcReport('mailer-daemon@mx.example.net', 'Undelivered Mail Returned to Sender')).toBe(false);
    expect(isDmarcReport('postmaster@example.net', 'Delivery Status Notification (Failure)')).toBe(false);
    expect(isDmarcReport('friend@example.com', 'Report on the shooting day')).toBe(false);
  });
});
