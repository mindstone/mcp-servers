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
    emailDomains: ['yahoo.com', 'ymail.com', 'rocketmail.com'],
  },
  gmail: {
    name: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true,
    authType: 'app-password',
    folderFallbacks: {
      sent: ['[Gmail]/Sent Mail', 'Sent Mail', 'Sent'],
      trash: ['[Gmail]/Trash', 'Trash'],
      junk: ['[Gmail]/Spam', 'Spam'],
      drafts: ['[Gmail]/Drafts', 'Drafts'],
      archive: ['[Gmail]/All Mail', 'All Mail'],
    },
    quirks: ['Requires app-specific password (2FA accounts) or OAuth2'],
    emailDomains: ['gmail.com', 'googlemail.com'],
  },
  outlook: {
    name: 'Outlook / Microsoft 365',
    imapHost: 'outlook.office365.com',
    imapPort: 993,
    imapTls: true,
    smtpHost: 'smtp-mail.outlook.com',
    smtpPort: 587,
    smtpSecure: false,
    authType: 'app-password',
    folderFallbacks: {
      sent: ['Sent Items', 'Sent'],
      trash: ['Deleted Items', 'Trash'],
      junk: ['Junk Email', 'Junk'],
      drafts: ['Drafts'],
      archive: ['Archive'],
    },
    emailDomains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
  },
};

/**
 * Get provider preset by name. Returns undefined for custom/unknown providers.
 */
export function getPreset(provider: string): ProviderPreset | undefined {
  return PRESETS[provider.toLowerCase()];
}

/**
 * List the keys of all presets that ship with the connector. Used by the
 * resolver to build human-readable error messages and by the presets test
 * to iterate every supported provider.
 */
export function listPresetKeys(): string[] {
  return Object.keys(PRESETS);
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

/**
 * Auto-detect the provider key (e.g. `gmail`, `icloud`, `yahoo`, `outlook`)
 * from the email's domain via each preset's `emailDomains` list.
 *
 * Returns `undefined` if no preset claims the domain — callers MUST refuse
 * to start in that case rather than silently falling back to a default
 * provider (see VAL-EMAIL-012).
 */
export function detectProviderFromEmail(email: string): string | undefined {
  const at = email.indexOf('@');
  if (at < 0) return undefined;
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain) return undefined;

  for (const [key, preset] of Object.entries(PRESETS)) {
    for (const dom of preset.emailDomains) {
      if (dom === domain) return key;
    }
  }

  // Yahoo runs many country-code TLDs (yahoo.co.uk, yahoo.fr, …) that are not
  // worth listing exhaustively in `emailDomains`. Fall back to the wildcard
  // family check so common international Yahoo addresses still auto-detect.
  if (isYahooDomain(domain)) return 'yahoo';

  return undefined;
}
