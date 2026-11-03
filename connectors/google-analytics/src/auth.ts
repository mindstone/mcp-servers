/**
 * Google Analytics authentication.
 *
 * Resolves Google Application Default Credentials (ADC) at startup and
 * exposes a single getAccessToken() helper. Validates that the credentials
 * file exists and is reachable so downstream tools fail with a clear,
 * actionable error rather than a deep google-auth-library stack trace.
 */

import path from 'node:path';
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import { activeScope, adcLoginCommand, GoogleAnalyticsError } from './types.js';

let authInstance: GoogleAuth | null = null;

/**
 * Validate the GOOGLE_APPLICATION_CREDENTIALS env var and create the
 * GoogleAuth client. Idempotent — subsequent calls return the cached
 * instance.
 *
 * Throws a structured GoogleAnalyticsError on misconfiguration:
 * - Env var missing or empty
 * - Path is not absolute (Node does not expand ~ or %APPDATA%)
 * - File does not exist or is not readable
 */
export function getAuth(): GoogleAuth {
  if (authInstance) return authInstance;

  const credentialsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialsPath || credentialsPath.trim() === '') {
    throw new GoogleAnalyticsError(
      'GOOGLE_APPLICATION_CREDENTIALS is not set.',
      'CREDENTIALS_NOT_CONFIGURED',
      `Set GOOGLE_APPLICATION_CREDENTIALS to the absolute path of your ADC or service-account JSON. To mint ADC, install the Google Cloud CLI then run: ${adcLoginCommand()}`,
    );
  }

  if (!path.isAbsolute(credentialsPath)) {
    throw new GoogleAnalyticsError(
      `GOOGLE_APPLICATION_CREDENTIALS must be an absolute path (received: ${credentialsPath}).`,
      'CREDENTIALS_PATH_NOT_ABSOLUTE',
      'Node does not expand ~ or %APPDATA% — provide a fully-resolved absolute path. On macOS the default ADC location is /Users/<you>/.config/gcloud/application_default_credentials.json.',
    );
  }

  try {
    fs.accessSync(credentialsPath, fs.constants.R_OK);
  } catch (error) {
    throw new GoogleAnalyticsError(
      `Cannot read credentials file at ${credentialsPath}.`,
      'CREDENTIALS_FILE_UNREADABLE',
      `Verify the file exists and is readable. ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  authInstance = new GoogleAuth({
    keyFilename: credentialsPath,
    // Service-account credentials honour this scope. Authorized-user ADC
    // carries the scopes it was minted with, which is why the setup docs
    // mint it with analytics.edit when writes are enabled.
    scopes: [activeScope()],
  });
  return authInstance;
}

/** Mint an OAuth access token from the configured ADC. */
export async function getAccessToken(): Promise<string> {
  const auth = getAuth();
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const token =
    typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token;
  if (!token) {
    throw new GoogleAnalyticsError(
      'Failed to obtain Google access token.',
      'TOKEN_FETCH_FAILED',
      `Re-run \`${adcLoginCommand()}\` to refresh credentials, then reconnect this connector in your MCP host.`,
    );
  }
  return token;
}

/** Reset cached auth instance (used by tests). */
export function resetAuthForTests(): void {
  authInstance = null;
}
