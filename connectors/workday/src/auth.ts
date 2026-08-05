/**
 * Workday authentication module.
 *
 * OAuth2 dual grant type: client_credentials (default) + refresh_token (when available).
 * Credentials managed via env vars or configured at runtime.
 *
 * Environment variables:
 * - WORKDAY_HOST: Workday API domain (e.g., wd5-impl-services1.workday.com)
 * - WORKDAY_TENANT: Customer's Workday tenant name
 * - WORKDAY_CLIENT_ID: OAuth client ID
 * - WORKDAY_CLIENT_SECRET: OAuth client secret
 * - WORKDAY_REFRESH_TOKEN: Optional refresh token (enables refresh_token grant)
 */

import { WorkdayError, USER_AGENT, REQUEST_TIMEOUT_MS, RECRUITING_API_VERSION_DEFAULT } from './types.js';
import { bridgeRequest } from './bridge.js';

// ── Runtime credentials ──

let workdayHost: string = '';
let workdayTenant: string = process.env.WORKDAY_TENANT ?? '';
let clientId: string = process.env.WORKDAY_CLIENT_ID ?? '';
let clientSecret: string = process.env.WORKDAY_CLIENT_SECRET ?? '';
let refreshToken: string = process.env.WORKDAY_REFRESH_TOKEN ?? '';

// Validate WORKDAY_HOST from env at startup — reject private/localhost hosts
const _envHost = process.env.WORKDAY_HOST ?? '';
if (_envHost) {
  const _hostResult = validateHost(_envHost);
  if (_hostResult.valid) {
    workdayHost = _hostResult.host!;
  } else {
    console.error(`[Workday] Ignoring invalid WORKDAY_HOST from env: ${_hostResult.error}`);
  }
}

// ── Token cache ──

let cachedAccessToken: string | null = null;
let tokenExpiresAt = 0;

// ── Getters / setters ──

export function getHost(): string {
  return workdayHost;
}

export function setHost(h: string): void {
  workdayHost = h;
}

export function getTenant(): string {
  return workdayTenant;
}

export function setTenant(t: string): void {
  workdayTenant = t;
}

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

export function clearTokenCache(): void {
  cachedAccessToken = null;
  tokenExpiresAt = 0;
}

export function isConfigured(): boolean {
  return !!(workdayHost && workdayTenant && clientId && clientSecret);
}

export function getTokenUrl(): string {
  return `https://${workdayHost}/ccx/oauth2/${workdayTenant}/token`;
}

export function getApiBaseUrl(): string {
  return `https://${workdayHost}/ccx/api/v1/${workdayTenant}`;
}

// Workday's wider REST surface is split into per-domain service families
// (e.g. absenceManagement/v1, payroll/v2) that hang off /ccx/api/ rather
// than the /ccx/api/v1/{tenant} alias used for the core worker/org endpoints.
export function getServiceApiBaseUrl(serviceFamily: string): string {
  return `https://${workdayHost}/ccx/api/${serviceFamily}/${workdayTenant}`;
}

// Recruiting REST family, with the platform-release version segment
// overridable because tenants on different Workday releases expose
// different versions.
export function getRecruitingApiFamily(): string {
  const raw = (process.env.WORKDAY_RECRUITING_API_VERSION ?? '').trim();
  if (!raw) return `recruiting/${RECRUITING_API_VERSION_DEFAULT}`;
  if (!/^v\d+(\.\d+)?$/.test(raw)) {
    console.error('[Workday] Ignoring invalid WORKDAY_RECRUITING_API_VERSION (expected e.g. "v41.2")');
    return `recruiting/${RECRUITING_API_VERSION_DEFAULT}`;
  }
  return `recruiting/${raw}`;
}

// ── SSRF / Host validation ──

function normalizeHost(raw: string): string {
  let host = raw.trim();
  host = host.replace(/^https?:\/\//i, '');
  host = host.replace(/\/+$/, '');
  return host;
}

function isPrivateOrLocalhost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower === '[::1]') {
    return true;
  }

  const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipMatch) {
    const [, a, b] = ipMatch.map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  return false;
}

export function validateHost(rawHost: string): { valid: boolean; host?: string; error?: string } {
  const host = normalizeHost(rawHost);
  if (!host || host.length === 0) {
    return { valid: false, error: 'Host is required.' };
  }

  if (isPrivateOrLocalhost(host)) {
    return { valid: false, error: 'Host must not be localhost or a private IP address.' };
  }

  if (host.length < 2 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]*[a-zA-Z0-9]$/.test(host)) {
    return { valid: false, error: 'Host must be a valid hostname.' };
  }

  return { valid: true, host };
}

// ── Token exchange ──

export async function getAccessToken(): Promise<string> {
  if (!clientId || !clientSecret) {
    throw new WorkdayError(
      'Workday not configured. Call configure_workday_credentials first.',
      'NOT_CONFIGURED',
      'Configure Workday with your OAuth credentials first.',
    );
  }

  if (cachedAccessToken && Date.now() < tokenExpiresAt) {
    return cachedAccessToken;
  }

  const authHeader = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const bodyParams: Record<string, string> = refreshToken
    ? { grant_type: 'refresh_token', refresh_token: refreshToken }
    : { grant_type: 'client_credentials' };

  const body = new URLSearchParams(bodyParams);

  let response: Response;
  try {
    response = await fetch(getTokenUrl(), {
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
      throw new WorkdayError(
        'OAuth token request timed out',
        'TIMEOUT',
        'The request took too long. Check your Workday host and network connectivity.',
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
    throw new WorkdayError(
      `OAuth token exchange failed (${response.status}): ${errorText}`,
      'AUTH_FAILED',
      'Re-configure with configure_workday_credentials. Check client ID, secret, and tenant.',
    );
  }

  const tokenData = await response.json() as {
    access_token: string;
    token_type: string;
    expires_in: number;
    refresh_token?: string;
  };

  cachedAccessToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + (tokenData.expires_in - 60) * 1000;

  // Handle refresh token rotation
  if (tokenData.refresh_token && tokenData.refresh_token !== refreshToken) {
    refreshToken = tokenData.refresh_token;
    bridgeRequest('/bundled/workday/update-refresh-token', {
      refreshToken: tokenData.refresh_token,
    }).catch((err) => {
      console.error('Failed to persist rotated refresh token:', err instanceof Error ? err.message : String(err));
    });
  }

  return cachedAccessToken;
}
