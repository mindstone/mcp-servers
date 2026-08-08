export const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeState {
  port: number;
  token: string;
}

export class EmailImapError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'EmailImapError';
  }
}

/**
 * Provider preset configuration for well-known email providers.
 */
export interface ProviderPreset {
  name: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  authType: 'app-password';
  folderFallbacks: Record<string, string[]>;
  quirks?: string[];
  emailDomains: string[];
}

/**
 * Full client configuration for initializing IMAP and SMTP connections.
 */
export interface ClientConfig {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  /**
   * When true, force STARTTLS upgrade for SMTP submission. Always true for
   * known-provider presets and for `provider: custom` unless the custom
   * SMTP port is 25 (plaintext submission is allowed when configured).
   */
  smtpRequireTLS: boolean;
  email: string;
  password: string;
}

/**
 * IMAP client configuration subset.
 */
export interface ImapClientConfig {
  host: string;
  port: number;
  tls: boolean;
  user: string;
  pass: string;
}

/**
 * SMTP client configuration subset.
 */
export interface SmtpClientConfig {
  host: string;
  port: number;
  secure: boolean;
  /**
   * When true, force STARTTLS upgrade. Maps to nodemailer's `requireTLS` /
   * `tls.required` option so a plain-port (587) submission cannot silently
   * stay un-encrypted.
   */
  requireTLS?: boolean;
  user: string;
  pass: string;
}

/**
 * Interface for a mail transporter (abstracted for testing).
 */
export interface MailTransporter {
  sendMail(mailOptions: Record<string, unknown>): Promise<{ messageId?: string }>;
  close(): void;
  verify?: () => Promise<boolean>;
}
