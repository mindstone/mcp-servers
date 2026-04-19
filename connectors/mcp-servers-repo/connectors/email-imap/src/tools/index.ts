/**
 * Email IMAP tool registration — aggregates all tool modules.
 */

import { getPreset } from '../presets.js';
import { initImap, cleanup as cleanupImap } from '../imap-client.js';
import { initSmtp, cleanup as cleanupSmtp } from '../smtp-client.js';
import type { ClientConfig } from '../types.js';
import { setClientConfig } from './shared.js';

export { registerMailboxTools } from './mailbox.js';
export { registerMessageTools } from './messages.js';
export { registerSendTools } from './send.js';
export { registerConfigureTools, getCredentials, setCredentials } from './configure.js';

/**
 * Options for initializing email clients.
 * Can be passed a full ClientConfig or simplified provider-based options.
 */
interface InitClientsOptions {
  email: string;
  password: string;
  provider: string;
  /** Explicit IMAP/SMTP config overrides (for custom provider) */
  imapHost?: string;
  imapPort?: number;
  imapTls?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
}

/**
 * Initialize IMAP and SMTP clients from provider settings or explicit config.
 */
export async function initClients(options: InitClientsOptions): Promise<void> {
  const normalizedProvider = options.provider.trim().toLowerCase();

  let config: ClientConfig;

  if (normalizedProvider === 'custom') {
    const imapHost = options.imapHost ?? process.env.EMAIL_IMAP_IMAP_HOST?.trim();
    const smtpHost = options.smtpHost ?? process.env.EMAIL_IMAP_SMTP_HOST?.trim();
    if (!imapHost || !smtpHost) {
      throw new Error('Custom email requires IMAP and SMTP server addresses. Provide imapHost and smtpHost.');
    }
    const imapPort = options.imapPort ?? parseInt(process.env.EMAIL_IMAP_IMAP_PORT || '993', 10);
    const smtpPort = options.smtpPort ?? parseInt(process.env.EMAIL_IMAP_SMTP_PORT || '587', 10);

    config = {
      imapHost,
      imapPort,
      imapTls: options.imapTls ?? imapPort === 993,
      smtpHost,
      smtpPort,
      smtpSecure: options.smtpSecure ?? smtpPort === 465,
      email: options.email.trim(),
      password: options.password.trim(),
    };
  } else {
    const preset = getPreset(normalizedProvider);
    if (!preset) {
      throw new Error(`Unsupported provider "${normalizedProvider}". Supported providers: icloud, yahoo, custom.`);
    }

    config = {
      imapHost: preset.imapHost,
      imapPort: preset.imapPort,
      imapTls: preset.imapTls,
      smtpHost: preset.smtpHost,
      smtpPort: preset.smtpPort,
      smtpSecure: preset.smtpSecure,
      email: options.email.trim(),
      password: options.password.trim(),
    };
  }

  setClientConfig(config);

  await initImap({
    host: config.imapHost,
    port: config.imapPort,
    tls: config.imapTls,
    user: config.email,
    pass: config.password,
  });

  await initSmtp({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    user: config.email,
    pass: config.password,
  });
}

/**
 * Clean up all email clients.
 */
export async function cleanupClients(): Promise<void> {
  await Promise.allSettled([cleanupImap(), cleanupSmtp()]);
  setClientConfig(null);
}
