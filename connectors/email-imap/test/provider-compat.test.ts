import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { createImapMock } from './helpers/imap-mock.js';
import { createSmtpMock } from './helpers/smtp-mock.js';

const { MockImapFlow } = createImapMock();
const { createTransport: mockCreateTransport } = createSmtpMock();

vi.mock('imapflow', () => ({
  ImapFlow: MockImapFlow,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: mockCreateTransport },
  createTransport: mockCreateTransport,
}));

/**
 * Tests for M3.4 — email-imap provider compat (VAL-EMAIL-010..019).
 *
 * The "resolver" exposed by these tests is a small helper
 * (`resolveClientConfig`) that the connector's startup path uses to turn
 * raw (email, password, provider) inputs into a fully-validated
 * `ClientConfig`. It must:
 *   - auto-detect the provider from the email's domain when no provider is
 *     given, using `presets.ts`'s `emailDomains` map (gmail, icloud, yahoo,
 *     outlook),
 *   - refuse to start (throw) when no domain match exists — never silently
 *     fall back to iCloud,
 *   - require TLS for `provider: custom` by default, while allowing
 *     cleartext ports (imap=143, smtp=25) when configured — capability-first:
 *     the host owns the plaintext decision.
 */

describe('Provider compat — auto-detect (VAL-EMAIL-010..013, 019)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('VAL-EMAIL-010 — auto-detects gmail from @gmail.com', async () => {
    vi.resetModules();
    const { detectProviderFromEmail, getPreset } = await import('../src/presets.js');
    expect(detectProviderFromEmail('alice@gmail.com')).toBe('gmail');

    const gmail = getPreset('gmail');
    expect(gmail).toBeDefined();
    expect(gmail!.imapHost).toBe('imap.gmail.com');
  });

  it('VAL-EMAIL-010 — resolver returns gmail when EMAIL_IMAP_PROVIDER unset and EMAIL_IMAP_EMAIL=alice@gmail.com', async () => {
    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'alice@gmail.com',
      password: 'pw',
      provider: '',
    });
    expect(cfg.imapHost).toBe('imap.gmail.com');
  });

  it('VAL-EMAIL-011 — auto-detects every preset entry that declares emailDomains', async () => {
    vi.resetModules();
    const presetsModule = await import('../src/presets.js');
    const { detectProviderFromEmail, listPresetKeys, getPreset } = presetsModule;

    const presetKeys = listPresetKeys();
    expect(presetKeys.length).toBeGreaterThan(0);

    let assertedDomains = 0;
    for (const key of presetKeys) {
      const preset = getPreset(key)!;
      for (const domain of preset.emailDomains) {
        const detected = detectProviderFromEmail(`user@${domain}`);
        expect(detected, `domain ${domain} should map to ${key}`).toBe(key);
        assertedDomains++;
      }
    }
    // Sanity: at least icloud + yahoo + gmail + outlook contribute domains.
    expect(assertedDomains).toBeGreaterThanOrEqual(7);
  });

  it('VAL-EMAIL-011 — yahoo wildcard (yahoo.co.uk, yahoo.fr) also resolves to yahoo', async () => {
    vi.resetModules();
    const { detectProviderFromEmail } = await import('../src/presets.js');
    expect(detectProviderFromEmail('user@yahoo.co.uk')).toBe('yahoo');
    expect(detectProviderFromEmail('user@yahoo.fr')).toBe('yahoo');
  });

  it('VAL-EMAIL-012 — unknown domain refuses, NOT silent iCloud fallback', async () => {
    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');

    expect(() =>
      resolveClientConfig({
        email: 'alice@unknown-domain.invalid',
        password: 'pw',
        provider: '',
      }),
    ).toThrow(/provider/i);

    let captured: Error | null = null;
    try {
      resolveClientConfig({
        email: 'alice@unknown-domain.invalid',
        password: 'pw',
        provider: '',
      });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured!.message.toLowerCase()).toMatch(/provider/);
    expect(captured!.message.toLowerCase()).toMatch(/unknown|unrecognis|unable to detect|must set email_imap_provider/);
    // Defence-in-depth: 'icloud' MUST NOT appear in the resolved config /
    // error message. The error must NOT secretly resolve to icloud anywhere.
    expect(captured!.message.toLowerCase()).not.toMatch(/^icloud$/);
  });

  it('VAL-EMAIL-013 — silent-icloud-default expression is gone (static)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const indexSrc = fs.readFileSync(
      path.resolve(__dirname, '../src/index.ts'),
      'utf8',
    );
    expect(indexSrc).not.toMatch(/creds\.provider[^|]*\|\|\s*['"]icloud['"]/);
    // Also check there's no comment like "'icloud' // default"
    expect(indexSrc).not.toMatch(/['"]icloud['"]\s*\/\/\s*default/i);
  });

  it('VAL-EMAIL-019 — explicit EMAIL_IMAP_PROVIDER wins over auto-detect', async () => {
    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'alice@gmail.com',
      password: 'pw',
      provider: 'yahoo',
    });
    expect(cfg.imapHost).toBe('imap.mail.yahoo.com');
  });
});

describe('Provider compat — custom TLS defaults & plaintext allowance (VAL-EMAIL-014..018)', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('VAL-EMAIL-014 — custom provider defaults to TLS (positive)', async () => {
    vi.stubEnv('EMAIL_IMAP_PROVIDER', 'custom');
    vi.stubEnv('EMAIL_IMAP_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('EMAIL_IMAP_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_IMAP_IMAP_PORT', '');
    vi.stubEnv('EMAIL_IMAP_SMTP_PORT', '');

    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'me@example.com',
      password: 'pw',
      provider: 'custom',
    });
    expect(cfg.imapTls).toBe(true);
    expect(cfg.smtpRequireTLS).toBe(true);
  });

  it('VAL-EMAIL-015 — custom + imap_port=143 → plaintext allowed by default', async () => {
    vi.stubEnv('EMAIL_IMAP_PROVIDER', 'custom');
    vi.stubEnv('EMAIL_IMAP_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('EMAIL_IMAP_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_IMAP_IMAP_PORT', '143');
    vi.stubEnv('EMAIL_IMAP_SMTP_PORT', '');

    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'me@example.com',
      password: 'pw',
      provider: 'custom',
    });
    expect(cfg.imapTls).toBe(false);
    expect(cfg.imapPort).toBe(143);
  });

  it('VAL-EMAIL-016 — custom + smtp_port=25 → plaintext allowed by default', async () => {
    vi.stubEnv('EMAIL_IMAP_PROVIDER', 'custom');
    vi.stubEnv('EMAIL_IMAP_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('EMAIL_IMAP_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_IMAP_IMAP_PORT', '');
    vi.stubEnv('EMAIL_IMAP_SMTP_PORT', '25');

    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'me@example.com',
      password: 'pw',
      provider: 'custom',
    });
    expect(cfg.smtpPort).toBe(25);
    expect(cfg.smtpRequireTLS).toBe(false);
  });

  it('VAL-EMAIL-017 — explicit imapTls override still wins on a cleartext port', async () => {
    vi.stubEnv('EMAIL_IMAP_PROVIDER', 'custom');
    vi.stubEnv('EMAIL_IMAP_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('EMAIL_IMAP_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_IMAP_IMAP_PORT', '143');
    vi.stubEnv('EMAIL_IMAP_SMTP_PORT', '587');

    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'me@example.com',
      password: 'pw',
      provider: 'custom',
      imapTls: true,
    });
    expect(cfg.imapTls).toBe(true);
    expect(cfg.imapPort).toBe(143);
  });

  it('VAL-EMAIL-017b — explicit imapTls: false override wins on a TLS port', async () => {
    vi.stubEnv('EMAIL_IMAP_PROVIDER', 'custom');
    vi.stubEnv('EMAIL_IMAP_IMAP_HOST', 'imap.example.com');
    vi.stubEnv('EMAIL_IMAP_SMTP_HOST', 'smtp.example.com');
    vi.stubEnv('EMAIL_IMAP_IMAP_PORT', '993');
    vi.stubEnv('EMAIL_IMAP_SMTP_PORT', '587');

    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');
    const cfg = resolveClientConfig({
      email: 'me@example.com',
      password: 'pw',
      provider: 'custom',
      imapTls: false,
    });
    expect(cfg.imapTls).toBe(false);
    expect(cfg.imapPort).toBe(993);
  });

  it('VAL-EMAIL-018 — known providers continue to resolve when EMAIL_IMAP_PROVIDER is set explicitly', async () => {
    vi.resetModules();
    const { resolveClientConfig } = await import('../src/tools/index.js');

    for (const [provider, expectedHost] of [
      ['icloud', 'imap.mail.me.com'],
      ['yahoo', 'imap.mail.yahoo.com'],
      ['gmail', 'imap.gmail.com'],
      ['outlook', 'outlook.office365.com'],
    ] as const) {
      const cfg = resolveClientConfig({
        email: `user@${provider === 'icloud' ? 'icloud.com' : provider === 'yahoo' ? 'yahoo.com' : provider === 'gmail' ? 'gmail.com' : 'outlook.com'}`,
        password: 'pw',
        provider,
      });
      expect(cfg.imapHost).toBe(expectedHost);
      expect(cfg.imapTls).toBe(true);
    }
  });
});
