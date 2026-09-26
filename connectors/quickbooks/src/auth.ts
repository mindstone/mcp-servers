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

import { z } from 'zod';

import { QuickBooksError, TOKEN_URL, USER_AGENT, REQUEST_TIMEOUT_MS } from './types.js';
import { bridgeRequest } from './bridge.js';
import { wrapUntrusted } from './untrusted-content.js';

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
//
// requestToken is the only refresh-token grant in this connector: both
// getAccessToken and configure_quickbooks go through it, and both apply its
// result with adoptTokenResponse. Intuit can rotate the refresh token on any
// grant (the old one then stops working), so a grant whose response is not
// adopted leaves a dead token behind — which is how setup used to lose it.

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
  refresh_token: z.string().min(1).optional(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;

export interface TokenGrantCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Why a grant failed. `description` is bounded Intuit text, already enveloped. */
export type TokenGrantFailure =
  | { kind: 'timeout' }
  | { kind: 'network'; error: unknown }
  | { kind: 'http'; status: number; description?: string }
  | { kind: 'malformed'; status: number };

export type TokenGrantResult =
  | { ok: true; token: TokenResponse }
  | { ok: false; failure: TokenGrantFailure };

/** An OAuth error code: short, lowercase, underscores (RFC 6749 §5.2). */
const OAUTH_ERROR_CODE = /^[a-z_]{1,64}$/;

/**
 * The part of a failed grant's body that may reach the model: Intuit's
 * `error_description`, else a well-formed OAuth `error` code, enveloped
 * (AGENTS.md #6). Never the rest of the body or non-JSON text: a diagnostic
 * body can reflect the credentials just sent.
 */
async function oauthErrorDescription(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const { error, error_description: description } = (body ?? {}) as Record<string, unknown>;
  if (typeof description === 'string' && description) {
    return wrapUntrusted(description, 'quickbooks:oauth-error');
  }
  if (typeof error === 'string' && OAUTH_ERROR_CODE.test(error)) {
    return wrapUntrusted(error, 'quickbooks:oauth-error');
  }
  return undefined;
}

/** One refresh-token grant. Sets no module state; callers adopt the result. */
export async function requestToken(creds: TokenGrantCredentials): Promise<TokenGrantResult> {
  const authHeader = 'Basic ' + Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: creds.refreshToken,
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
      return { ok: false, failure: { kind: 'timeout' } };
    }
    return { ok: false, failure: { kind: 'network', error } };
  }

  if (!response.ok) {
    return { ok: false, failure: { kind: 'http', status: response.status, description: await oauthErrorDescription(response) } };
  }

  // A parse error message embeds a snippet of the (Intuit-controlled) body, so
  // a non-JSON or malformed 2xx is reported by status only.
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return { ok: false, failure: { kind: 'malformed', status: response.status } };
  }
  const parsed = tokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    return { ok: false, failure: { kind: 'malformed', status: response.status } };
  }
  return { ok: true, token: parsed.data };
}

/**
 * Apply a successful grant to the runtime state: cache the access token and
 * take up a rotated refresh token. Returns the refresh token now in force.
 */
export function adoptTokenResponse(token: TokenResponse): { refreshToken: string; rotated: boolean } {
  cachedAccessToken = token.access_token;
  // Expire 60 seconds early to avoid edge cases
  tokenExpiresAt = Date.now() + (token.expires_in - 60) * 1000;
  const rotated = !!token.refresh_token && token.refresh_token !== refreshToken;
  if (token.refresh_token) refreshToken = token.refresh_token;
  return { refreshToken, rotated };
}

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

  const result = await requestToken({ clientId, clientSecret, refreshToken });
  if (!result.ok) {
    const { failure } = result;
    switch (failure.kind) {
      case 'timeout':
        throw new QuickBooksError(
          'OAuth token request timed out',
          'TIMEOUT',
          'The request took too long. Check your network connectivity.',
        );
      case 'network':
        throw failure.error;
      case 'http':
        throw new QuickBooksError(
          `OAuth token refresh failed (${failure.status}): ${failure.description ?? 'Unknown error'}`,
          'AUTH_FAILED',
          'Re-configure with configure_quickbooks. Check Client ID, Secret, and Refresh Token. Tokens expire after 100 days of inactivity.',
        );
      case 'malformed':
        throw new QuickBooksError(
          `OAuth token endpoint returned a non-JSON or malformed response (${failure.status}).`,
          'AUTH_FAILED',
          'Try again; if it persists, re-configure with configure_quickbooks.',
        );
      default: {
        const unreachable: never = failure;
        throw unreachable;
      }
    }
  }

  const adopted = adoptTokenResponse(result.token);
  if (adopted.rotated) {
    bridgeRequest('/bundled/quickbooks/update-refresh-token', {
      refreshToken: adopted.refreshToken,
    }).catch((err) => {
      console.error('Failed to persist rotated refresh token:', err instanceof Error ? err.message : String(err));
    });
  }

  return result.token.access_token;
}
