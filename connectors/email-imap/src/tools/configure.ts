/**
 * Configure tool — credentials management and provider selection.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bridgeRequest, BRIDGE_STATE_PATH } from '../bridge.js';
import { detectProviderFromEmail, getPreset, listPresetKeys } from '../presets.js';
import { EmailImapError } from '../types.js';
import { withErrorHandling } from '../utils.js';
import { initClients } from './index.js';

/**
 * Mutable env-level credential state.
 * Updated when the configure tool is called, so subsequent tool calls
 * use the new credentials even if the original env vars were empty.
 */
let EMAIL_IMAP_EMAIL = process.env.EMAIL_IMAP_EMAIL ?? '';
let EMAIL_IMAP_PASSWORD = process.env.EMAIL_IMAP_PASSWORD ?? '';
let EMAIL_IMAP_PROVIDER = process.env.EMAIL_IMAP_PROVIDER ?? '';

export function getCredentials(): {
  email: string;
  password: string;
  provider: string;
} {
  return {
    email: EMAIL_IMAP_EMAIL,
    password: EMAIL_IMAP_PASSWORD,
    provider: EMAIL_IMAP_PROVIDER,
  };
}

export function setCredentials(email: string, password: string, provider: string): void {
  EMAIL_IMAP_EMAIL = email;
  EMAIL_IMAP_PASSWORD = password;
  EMAIL_IMAP_PROVIDER = provider;
}

export function registerConfigureTools(server: McpServer): void {
  server.registerTool(
    'configure_email_imap',
    {
      description:
        'Configure email account. Call this when the user provides their email and app-specific password. ' +
        'For iCloud: generate an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords ' +
        '(guide: support.apple.com/en-gb/102654). For Yahoo: generate an app password at login.yahoo.com/myaccount/security/app-password.',
      inputSchema: z.object({
        email: z.string().min(1).describe('Email address for the account'),
        password: z.string().min(1).describe('App-specific password for the account'),
        provider: z
          .string()
          .optional()
          .describe('Email provider preset (icloud, yahoo, or custom)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    withErrorHandling(async (args) => {
      const email = args.email.trim();
      const password = args.password.trim();
      const providerArg = args.provider?.trim().toLowerCase() ?? '';
      const envProvider = EMAIL_IMAP_PROVIDER?.trim().toLowerCase() ?? '';
      // Mirror index.ts startup (M3.4 / VAL-EMAIL-012, VAL-EMAIL-026):
      // never silently default to a provider the caller did not pick.
      // If neither the tool argument nor the env var is set, auto-detect
      // from the email's domain, and refuse when no preset claims it.
      let provider = providerArg || envProvider;
      if (!provider) {
        const detected = detectProviderFromEmail(email);
        if (!detected) {
          const supported = [...listPresetKeys(), 'custom'].join(', ');
          throw new EmailImapError(
            `Unable to detect email provider from address "${email}": ` +
              `no preset claims its domain. Set EMAIL_IMAP_PROVIDER explicitly ` +
              `or pass the "provider" argument. Supported providers: ${supported}.`,
            'PROVIDER_DETECTION_FAILED',
            `Pass an explicit "provider" argument (one of: ${supported}) ` +
              `or set the EMAIL_IMAP_PROVIDER env var before calling configure_email_imap.`,
          );
        }
        provider = detected;
      }

      // For known providers, validate the preset
      if (provider !== 'custom') {
        const preset = getPreset(provider);
        if (!preset) {
          throw new EmailImapError(
            `Unsupported provider "${provider}". Supported providers: icloud, yahoo, custom.`,
            'INVALID_PROVIDER',
            'Use one of the supported providers or "custom" with explicit IMAP/SMTP settings.',
          );
        }
      }

      // If bridge is available, persist via bridge
      if (BRIDGE_STATE_PATH) {
        try {
          const result = await bridgeRequest('/bundled/email-imap/configure', {
            email,
            password,
            provider,
          });
          if (result.success) {
            setCredentials(email, password, provider);
            await initClients({
              email,
              password,
              provider,
            });

            const preset = getPreset(provider);
            const providerName = preset?.name ?? provider;
            const message = result.warning
              ? `Email IMAP configured successfully. Note: ${result.warning}`
              : `Email IMAP configured successfully for ${providerName}.`;
            return JSON.stringify({ ok: true, message, provider });
          }
          // Bridge returned failure — surface as error, do NOT fall through
          throw new EmailImapError(
            result.error || 'Bridge configuration failed',
            'BRIDGE_ERROR',
            'The host app bridge rejected the configuration request. Check the host app logs.',
          );
        } catch (error) {
          if (error instanceof EmailImapError) throw error;
          // Bridge request failed (network, timeout, etc.) — surface as error
          throw new EmailImapError(
            `Bridge request failed: ${error instanceof Error ? error.message : String(error)}`,
            'BRIDGE_ERROR',
            'Could not reach the host app bridge. Ensure the host app is running.',
          );
        }
      }

      // No bridge — configure directly
      setCredentials(email, password, provider);
      await initClients({
        email,
        password,
        provider,
      });

      const preset = getPreset(provider);
      const providerName = preset?.name ?? provider;
      return JSON.stringify({
        ok: true,
        message: `Email IMAP configured successfully for ${providerName}.`,
        provider,
      });
    }),
  );
}
