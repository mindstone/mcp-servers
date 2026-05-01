import nodemailer from 'nodemailer';
import type { SmtpClientConfig, MailTransporter } from './types.js';

let config: SmtpClientConfig | null = null;
let transport: MailTransporter | null = null;

function sameConfig(a: SmtpClientConfig, b: SmtpClientConfig): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.secure === b.secure &&
    a.requireTLS === b.requireTLS &&
    a.user === b.user &&
    a.pass === b.pass
  );
}

/**
 * Initialize SMTP transport with the given configuration.
 * If the config is the same as the current one, this is a no-op.
 */
export async function initSmtp(nextConfig: SmtpClientConfig): Promise<void> {
  if (config && sameConfig(config, nextConfig)) {
    return;
  }

  await cleanup();
  config = { ...nextConfig };
}

/**
 * Get the SMTP transport, creating it lazily if needed.
 */
export async function getTransport(): Promise<MailTransporter> {
  if (transport) {
    return transport;
  }

  if (!config) {
    throw new Error('SMTP client is not initialized');
  }

  const nextTransport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    // Force STARTTLS upgrade for plain-port (587) submission so a hostile
    // DNS / MITM cannot keep the connection in cleartext. Only `false`
    // when the user has explicitly opted into plaintext for `provider:
    // custom` via `EMAIL_IMAP_ALLOW_PLAINTEXT=1`.
    requireTLS: config.requireTLS ?? !config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });

  if (typeof nextTransport.verify === 'function') {
    await nextTransport.verify();
  }

  transport = nextTransport;
  return nextTransport;
}

/**
 * Clean up the SMTP transport.
 */
export async function cleanup(): Promise<void> {
  if (!transport) {
    return;
  }

  try {
    transport.close();
  } finally {
    transport = null;
  }
}
