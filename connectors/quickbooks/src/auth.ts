/**
 * QuickBooks Online authentication module.
 *
 * OAuth2 refresh token grant with token rotation.
 * Credentials managed via env vars or configured at runtime.
 * Supports sandbox vs production environment switching.
 *
 * Environment variables:
 * - QUICKBOOKS_CLIENT_ID: Intuit Developer app Client ID
 * - QUICKBOOKS_CLIENT_SECRET: Intuit Developer app Client Secret
 * - QUICKBOOKS_REFRESH_TOKEN: OAuth2 refresh token
 * - QUICKBOOKS_REALM_ID: QuickBooks company ID (Realm ID)
 * - QUICKBOOKS_ENVIRONMENT: "sandbox" or "production" (default: "production")
 */

import { QuickBooksError, TOKEN_URL, USER_AGENT, REQUEST_TIMEOUT_MS } from './types.js';
import { bridgeRequest } from './bridge.js';

// ── Runtime credentials ──

let clientId: string = process.env.QUICKBOOKS_CLIENT_ID ?? '';
let clientSecret: string = process.env.QUICKBOOKS_CLIENT_SECRET ?? '';
let refreshToken: string = process.env.QUICKBOOKS_REFRESH_TOKEN ?? '';
let realmId: string = process.env.QUICKBOOKS_REALM_ID ?? '';
let environment: string = (() => {
  const envVal = process.env.QUICKBOOKS_ENVIRONMENT ?? 'production';
  if (envVal !== 'sandbox' && envVal !== 'production') {
    throw new QuickBooksError(
      `Invalid QUICKBOOKS_ENVIRONMENT: "${envVal}". Must be "sandbox" or "production".`,
      'INVALID_CONFIG',
      'Set QUICKBOOKS_ENVIRONMENT to either "sandbox" or "production".',
    );
  }
  return envVal;
})();

// ── Token cache ──

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

// ── Getters / setters ──

export function getClientId(): string {
  return clientId;
}

export function setClientId(id: string): void {
  clientId = id;
}

export function getClientSecret(): string {
  return clientSecret;
}

export function setClientSecret(s: string): void {
  clientSecret = s;
}

export function getRefreshToken(): string {
  return refreshToken;
}

export function setRefreshToken(t: string): void {
  refreshToken = t;
}

export function getRealmId(): string {
  return realmId;
}

export function setRealmId(id: string): void {
  realmId = id;
}

export function getEnvironment(): string {
  return environment;
}

export function setEnvironment(env: string): void {
  environment = env;
}

export function clearTokenCache(): void {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}

export function isConfigured(): boolean {
  return !!(clientId && clientSecret && refreshToken && realmId);
}

// ── Environment / URL helpers ──

export function getApiHost(): string {
  return environment === 'sandbox'
    ? 'sandbox-quickbooks.api.intuit.com'
    : 'quickbooks.api.intuit.com';
}

export function getBaseUrl(): string {
  return `https://${getApiHost()}/v3/company/${realmId}`;
}

export function validateEnvironment(env: string): boolean {
  return env === 'sandbox' || env === 'production';
}

// ── Token exchange ──

export async function getAccessToken(): Promise<string> {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new QuickBooksError(
      'QuickBooks not configured. Call configure_quickbooks first.',
      'NOT_CONFIGURED',
      'Configure QuickBooks with your Intuit Developer app credentials first.',
    );
  }

  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });

  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: body.toString(),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new QuickBooksError(
        'OAuth token request timed out',
        'TIMEOUT',
        'The request took too long. Check your network connectivity.',
      );
    }
    throw error;
  }

  if (!response.ok) {
    let errorText: string;
    try {
      const errorBody = await response.json() as { error?: string; error_description?: string };
      errorText = errorBody?.error_description || errorBody?.error || JSON.stringify(errorBody);
    } catch {
      errorText = await response.text().catch(() => 'Unknown error');
    }
    throw new QuickBooksError(
      `OAuth token refresh failed (${response.status}): ${errorText}`,
      'AUTH_FAILED',
      'Re-configure with configure_quickbooks. Check Client ID, Secret, and Refresh Token. Tokens expire after 100 days of inactivity.',
    );
  }

  const tokenData = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  cachedAccessToken = tokenData.access_token;
  // Expire 60 seconds early to avoid edge cases
  tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

  // Handle refresh token rotation — Intuit may return a new refresh token
  if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
    refreshToken = tokenData.refresh_token;
    bridgeRequest('/bundled/quickbooks/update-refresh-token', {
      refreshToken: tokenData.refresh_token,
    }).catch((err) => {
      console.error('Failed to persist rotated refresh token:', err instanceof Error ? err.message : String(err));
    });
  }

  return cachedAccessToken;
}
