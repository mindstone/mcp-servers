/**
 * Kling authentication module.
 *
 * Manages access key + secret key lifecycle — env vars on startup, runtime
 * update via configure tool, and JWT generation with caching.
 *
 * Kling uses JWT signed with HS256 (access key as issuer, secret key as
 * signing key). Tokens are valid for 30 minutes and cached until near expiry.
 */

import { SignJWT } from 'jose';

let accessKey: string = process.env.KLING_ACCESS_KEY || '';
let secretKey: string = process.env.KLING_SECRET_KEY || '';

/** JWT token cache (refreshed when expired) */
let cachedToken: { jwt: string; expiresAt: number } | null = null;

/**
 * Returns the current access key.
 */
export function getAccessKey(): string {
  return accessKey;
}

/**
 * Returns the current secret key.
 */
export function getSecretKey(): string {
  return secretKey;
}

/**
 * Returns true if both access key and secret key are configured.
 */
export function isConfigured(): boolean {
  return accessKey.length > 0 && secretKey.length > 0;
}

/**
 * Update the API keys at runtime (e.g. after configure_kling_api_keys).
 * Clears the JWT cache to force re-generation with new credentials.
 */
export function setApiKeys(newAccessKey: string, newSecretKey: string): void {
  accessKey = newAccessKey;
  secretKey = newSecretKey;
  cachedToken = null;
}

/**
 * Generate a JWT token for Kling API authentication.
 * Tokens are valid for 30 minutes; cached and reused until near expiry (60s buffer).
 */
export async function getJwtToken(): Promise<string> {
  if (!accessKey || !secretKey) {
    throw new Error('KLING_ACCESS_KEY and KLING_SECRET_KEY must be set');
  }

  // Return cached token if still valid (with 60s buffer)
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.expiresAt > now + 60) {
    return cachedToken.jwt;
  }

  const secret = new TextEncoder().encode(secretKey);
  const expiresAt = now + 1800; // 30 minutes

  const jwt = await new SignJWT({
    iss: accessKey,
    exp: expiresAt,
    nbf: now - 5, // Valid from 5 seconds ago (clock skew buffer)
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(secret);

  cachedToken = { jwt, expiresAt };
  return jwt;
}

/**
 * Clear the cached JWT token. Used when credentials are updated.
 */
export function clearTokenCache(): void {
  cachedToken = null;
}
