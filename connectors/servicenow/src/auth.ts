/**
 * ServiceNow authentication module.
 *
 * Manages instance name + credential lifecycle — env vars on startup,
 * runtime update via configure tool, and bridge integration for host-app
 * credential management.
 *
 * Two auth methods are supported:
 *
 * - Basic auth (default): Authorization: Basic base64(username:password)
 * - OAuth 2.0 client credentials: Bearer tokens fetched from the instance's
 *   oauth_token.do endpoint and cached until shortly before expiry.
 *
 * Basic auth takes precedence when both are configured, so existing
 * configurations behave exactly as before.
 */

import { SINGLE_LABEL_INSTANCE_REGEX } from './types.js';

let instance: string = '';
let username: string = process.env.SERVICENOW_USERNAME || '';
let password: string = process.env.SERVICENOW_PASSWORD || '';
const clientId: string = process.env.SERVICENOW_CLIENT_ID || '';
const clientSecret: string = process.env.SERVICENOW_CLIENT_SECRET || '';

/**
 * Extracts a hostname from a user-provided input string.
 * Handles URLs, bare hostnames, and various formats.
 */
function extractHostnameFromUserInput(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const candidate = trimmed.includes('://') ? trimmed : `https://${trimmed}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return trimmed
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, '')
      .split('/')[0]
      .split('?')[0]
      .split('#')[0]
      .split(':')[0];
  }
}

/**
 * Normalizes a user-provided ServiceNow instance input to just the subdomain label.
 * Accepts: "acme", "acme.service-now.com", "https://acme.service-now.com", etc.
 * Returns undefined if the input is invalid.
 */
export function normalizeServiceNowInstanceInput(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const hostname = extractHostnameFromUserInput(input);
  if (!hostname) return undefined;

  const normalizedHostname = hostname.trim().toLowerCase().replace(/\.$/, '');
  const withoutSuffix = normalizedHostname.endsWith('.service-now.com')
    ? normalizedHostname.slice(0, -'.service-now.com'.length)
    : normalizedHostname;

  if (!withoutSuffix || withoutSuffix.includes('.') || !SINGLE_LABEL_INSTANCE_REGEX.test(withoutSuffix)) {
    return undefined;
  }
  return withoutSuffix;
}

// Initialize instance from env on module load
instance = normalizeServiceNowInstanceInput(process.env.SERVICENOW_INSTANCE) || '';

/**
 * Returns the current ServiceNow instance name (subdomain label).
 */
export function getInstance(): string {
  return instance;
}

/**
 * Returns the current ServiceNow username.
 */
export function getUsername(): string {
  return username;
}

/**
 * Returns the current ServiceNow password.
 */
export function getPassword(): string {
  return password;
}

/**
 * Returns true if instance + username + password are all configured.
 */
export function isBasicConfigured(): boolean {
  return instance.length > 0 && username.length > 0 && password.length > 0;
}

/**
 * Returns true if instance + OAuth client ID + client secret are all configured.
 */
export function isOAuthConfigured(): boolean {
  return instance.length > 0 && clientId.length > 0 && clientSecret.length > 0;
}

/**
 * Returns true if any supported auth method is fully configured.
 */
export function isConfigured(): boolean {
  return isBasicConfigured() || isOAuthConfigured();
}

/**
 * Returns the OAuth client ID (empty string when unset).
 */
export function getOAuthClientId(): string {
  return clientId;
}

/**
 * Returns the OAuth client secret (empty string when unset).
 */
export function getOAuthClientSecret(): string {
  return clientSecret;
}

// ── OAuth bearer token cache ─────────────────────────────────────

let oauthToken: { accessToken: string; expiresAtMs: number } | null = null;

/**
 * Returns the cached OAuth access token if it is still valid, else null.
 */
export function getCachedOAuthToken(): string | null {
  if (oauthToken && Date.now() < oauthToken.expiresAtMs) {
    return oauthToken.accessToken;
  }
  return null;
}

/**
 * Cache an OAuth access token. The token is considered expired 60 seconds
 * before its stated lifetime so in-flight requests never use a stale token.
 */
export function setCachedOAuthToken(accessToken: string, expiresInSeconds: number): void {
  const REFRESH_MARGIN_MS = 60_000;
  oauthToken = {
    accessToken,
    expiresAtMs: Date.now() + Math.max(0, expiresInSeconds * 1000 - REFRESH_MARGIN_MS),
  };
}

/**
 * Drop the cached OAuth token (e.g. after a 401) so the next request
 * fetches a fresh one.
 */
export function clearOAuthToken(): void {
  oauthToken = null;
}

/**
 * Update credentials at runtime (e.g. after configure_servicenow).
 */
export function setCredentials(inst: string, user: string, pass: string): void {
  instance = inst;
  username = user;
  password = pass;
}
