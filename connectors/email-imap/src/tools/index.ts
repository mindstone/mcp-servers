/**
 * Email IMAP tool registration — aggregates all tool modules.
 */

import { detectProviderFromEmail, getPreset, listPresetKeys } from '../presets.js';
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
 * Resolve a fully-validated `ClientConfig` from raw startup inputs.
 *
 * This is the central place where the connector enforces its compat &
 * security policies (M3.4 / VAL-EMAIL-010..019):
 *
 *  1. If `provider` is empty, auto-detect from the email's domain via
 *     `presets.ts`'s `emailDomains` map. Throws when no domain matches —
 *     the connector MUST refuse to start rather than silently default to
 *     a provider the user did not pick (no `'icloud'` fallback).
 *  2. For `provider: custom`, default to TLS for both IMAP (993) and SMTP
 *     (587 STARTTLS / 465 implicit). Cleartext ports (`imap=143`,
 *     `smtp=25`) are refused unless the user opts in by setting
 *     `EMAIL_IMAP_ALLOW_PLAINTEXT=1`.
 *
 * Pure function (no I/O); thin enough that unit tests can drive it
 * directly without standing up the IMAP/SMTP clients.
 */
export function resolveClientConfig(options: InitClientsOptions): ClientConfig {
  const email = options.email.trim();
  const password = options.password.trim();
  const explicitProvider = options.provider.trim().toLowerCase();

  // (a) auto-detect when no provider explicitly given
  let provider = explicitProvider;
  if (!provider) {
    const detected = detectProviderFromEmail(email);
    if (!detected) {
      const supported = [...listPresetKeys(), 'custom'].join(', ');
      throw new Error(
        `Unable to detect email provider from address "${email}": ` +
          `no preset claims its domain. Set EMAIL_IMAP_PROVIDER explicitly ` +
          `to one of: ${supported}.`,
      );
    }
    provider = detected;
  }

  if (provider === 'custom') {
    return resolveCustomConfig(options, email, password);
  }

  const preset = getPreset(provider);
  if (!preset) {
    throw new Error(
      `Unsupported provider "${provider}". Supported providers: ${[...listPresetKeys(), 'custom'].join(', ')}.`,
    );
  }

  return {
    imapHost: preset.imapHost,
    imapPort: preset.imapPort,
    imapTls: preset.imapTls,
    smtpHost: preset.smtpHost,
    smtpPort: preset.smtpPort,
    smtpSecure: preset.smtpSecure,
    // Known-provider presets are always TLS — for STARTTLS submission
    // (port 587), force the upgrade so a hostile DNS / MITM cannot keep
    // the connection in cleartext.
    smtpRequireTLS: true,
    email,
    password,
  };
}

function resolveCustomConfig(
  options: InitClientsOptions,
  email: string,
  password: string,
): ClientConfig {
  const imapHost = options.imapHost ?? process.env.EMAIL_IMAP_IMAP_HOST?.trim();
  const smtpHost = options.smtpHost ?? process.env.EMAIL_IMAP_SMTP_HOST?.trim();
  if (!imapHost || !smtpHost) {
    throw new Error(
      'Custom email requires IMAP and SMTP server addresses. Provide imapHost and smtpHost.',
    );
  }
  const imapPort =
    options.imapPort ?? parseInt(process.env.EMAIL_IMAP_IMAP_PORT || '993', 10);
  const smtpPort =
    options.smtpPort ?? parseInt(process.env.EMAIL_IMAP_SMTP_PORT || '587', 10);

  const allowPlaintext = process.env.EMAIL_IMAP_ALLOW_PLAINTEXT === '1';

  if ((imapPort === 143 || smtpPort === 25) && !allowPlaintext) {
    throw new Error(
      `Custom provider with cleartext ports (imap_port=${imapPort}, smtp_port=${smtpPort}) ` +
        `requires TLS by default. Set EMAIL_IMAP_ALLOW_PLAINTEXT=1 to opt out ` +
        `(NOT recommended — credentials and message bodies will travel in plaintext).`,
    );
  }

  // Imap TLS: cleartext only when on port 143 AND user opted in.
  const imapTls = options.imapTls ?? !(imapPort === 143 && allowPlaintext);
  // SMTP secure: implicit TLS on 465.
  const smtpSecure = options.smtpSecure ?? smtpPort === 465;
  // SMTP requireTLS: force STARTTLS upgrade unless the user opted into
  // plaintext on port 25.
  const smtpRequireTLS = !(smtpPort === 25 && allowPlaintext);

  return {
    imapHost,
    imapPort,
    imapTls,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpRequireTLS,
    email,
    password,
  };
}

/**
 * Initialize IMAP and SMTP clients from provider settings or explicit config.
 */
export async function initClients(options: InitClientsOptions): Promise<void> {
  const config = resolveClientConfig(options);

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
    requireTLS: config.smtpRequireTLS,
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
