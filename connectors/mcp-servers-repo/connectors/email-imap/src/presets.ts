import type { ProviderPreset } from './types.js';

const PRESETS: Record<string, ProviderPreset> = {
  icloud: {
    name: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpSecure: false,
    authType: 'app-password',
    folderFallbacks: {
      sent: ['Sent Messages', 'Sent'],
      trash: ['Deleted Messages', 'Trash'],
      junk: ['Junk'],
      drafts: ['Drafts'],
      archive: ['Archive'],
    },
    emailDomains: ['icloud.com', 'me.com', 'mac.com'],
  },
  yahoo: {
    name: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecure: true,
    authType: 'app-password',
    folderFallbacks: {
      sent: ['Sent'],
      trash: ['Trash'],
      junk: ['Bulk Mail', 'Spam'],
      drafts: ['Draft', 'Drafts'],
      archive: ['Archive'],
    },
    quirks: ['5 simultaneous IMAP connections per IP'],
    emailDomains: [],
  },
};

/**
 * Get provider preset by name. Returns undefined for custom/unknown providers.
 */
export function getPreset(provider: string): ProviderPreset | undefined {
  return PRESETS[provider.toLowerCase()];
}

/**
 * Check if the given domain is a Yahoo-family domain.
 */
export function isYahooDomain(domain: string): boolean {
  const normalized = domain.trim().toLowerCase();
  return (
    normalized === 'ymail.com' ||
    normalized === 'rocketmail.com' ||
    normalized === 'yahoo.com' ||
    normalized.startsWith('yahoo.')
  );
}
