import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger, redactEmail } from './logger.js';
import { atomicCredentialWrite, sweepStaleTemps } from './utils/atomicCredentialWrite.js';
import {
  MicrosoftCredentialFileError,
  parseCredentialJson,
  readGuardedCredentialFile,
} from './guardedCredentialRead.js';
import { z } from 'zod';

import type { MicrosoftAccount } from './types.js';
import type { MicrosoftCredentialFileKind, MicrosoftCredentialFileReason } from './guardedCredentialRead.js';

export type { MicrosoftAccount, MicrosoftCredentialFileKind, MicrosoftCredentialFileReason };
export { MicrosoftCredentialFileError };

const log = createLogger('microsoft-token');

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  token_type: string;
  scope?: string;
}

const expiryValueSchema = z.union([z.number(), z.string()]).nullish();

// Accepts every shape the host writes (pretty-printed, `expires_at: null` when a
// refresh response omitted expires_in, extra keys spread from an older token).
const rawTokenSchema = z
  .object({
    access_token: z.string().optional(),
    refresh_token: z.string().nullish(),
    token_type: z.string().nullish(),
    scope: z.string().nullish(),
    expires_at: expiryValueSchema,
    expiresAt: expiryValueSchema,
    expires_in: expiryValueSchema,
  })
  .passthrough();

type RawTokenData = z.infer<typeof rawTokenSchema>;

const accountsFileSchema = z
  .object({
    accounts: z
      .array(
        z
          .object({
            email: z.string().min(1),
            displayName: z.string().nullish(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type MicrosoftRefreshDisabledReason = 'token_expired' | 'refresh_failed';

export class MicrosoftRefreshDisabledError extends Error {
  readonly code = 'MICROSOFT_REFRESH_DISABLED';
  readonly reason: MicrosoftRefreshDisabledReason;
  readonly email: string;

  constructor(email: string, reason: MicrosoftRefreshDisabledReason, message?: string) {
    super(message ?? `Microsoft token refresh is disabled by host (reason=${reason}, email=${email})`);
    this.name = 'MicrosoftRefreshDisabledError';
    this.reason = reason;
    this.email = email;
  }
}

function isRefreshDisabled(): boolean {
  return process.env.MICROSOFT_DISABLE_REFRESH === '1';
}

/**
 * Read and schema-check a credential file. `null` means the file does not exist;
 * every other problem throws `MicrosoftCredentialFileError` (fixed message, no path or content).
 */
async function readCredentialFile<T>(
  filePath: string,
  kind: MicrosoftCredentialFileKind,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): Promise<T | null> {
  try {
    const text = await readGuardedCredentialFile(filePath, kind);
    if (text === null) return null;
    const parsed = schema.safeParse(parseCredentialJson(text, kind));
    if (!parsed.success) {
      throw new MicrosoftCredentialFileError(kind, 'invalid_shape');
    }
    return parsed.data;
  } catch (err) {
    if (err instanceof MicrosoftCredentialFileError) {
      log.warn('Refused Microsoft credential file', { kind, reason: err.reason });
    }
    throw err;
  }
}

function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

export class TokenProvider {
  private configDir: string;
  private cachedToken: TokenData | null = null;
  private clientId: string;
  private email: string | null = null;
  private staleTempSweepDone = false;

  constructor(configDir: string, clientId: string, email?: string) {
    this.configDir = configDir;
    this.clientId = clientId;
    this.email = email ?? null;
  }

  private getCredentialsDir(): string {
    return path.join(this.configDir, 'credentials');
  }

  private getTokenPath(email: string): string {
    return path.join(this.getCredentialsDir(), `${sanitizeEmail(email)}.token.json`);
  }

  private getLegacyTokenPath(): string {
    return path.join(this.configDir, 'tokens.json');
  }

  private getAccountsPath(): string {
    return path.join(this.configDir, 'accounts.json');
  }

  /** `[]` when accounts.json is missing; throws `MicrosoftCredentialFileError` when it is refused or invalid. */
  async loadAccounts(): Promise<MicrosoftAccount[]> {
    const config = await readCredentialFile(this.getAccountsPath(), 'accounts', accountsFileSchema);
    return (config?.accounts ?? []) as MicrosoftAccount[];
  }

  async getDefaultAccount(): Promise<string | null> {
    const accounts = await this.loadAccounts();
    return accounts.length > 0 ? accounts[0].email : null;
  }

  private async resolveEmail(email?: string): Promise<string> {
    const resolved = email ?? this.email ?? await this.getDefaultAccount();
    if (!resolved) {
      throw new Error('No Microsoft account found. Please connect your Microsoft account first.');
    }
    return resolved;
  }

  private normalizeToken(raw: RawTokenData | null): TokenData | null {
    if (!raw || typeof raw.access_token !== 'string' || raw.access_token.length === 0) {
      return null;
    }

    const expiresAt = this.normalizeExpiresAt(raw);

    return {
      access_token: raw.access_token,
      refresh_token: raw.refresh_token ?? undefined,
      expires_at: expiresAt,
      token_type: raw.token_type ?? 'Bearer',
      scope: raw.scope ?? undefined,
    };
  }

  private normalizeExpiresAt(raw: RawTokenData): number {
    const rawExpiresAt = raw.expires_at ?? raw.expiresAt;

    if (typeof rawExpiresAt === 'number' && Number.isFinite(rawExpiresAt)) {
      return rawExpiresAt;
    }

    if (typeof rawExpiresAt === 'string') {
      const numeric = Number(rawExpiresAt);
      if (Number.isFinite(numeric)) {
        return numeric;
      }
      const parsed = Date.parse(rawExpiresAt);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }

    if (raw.expires_in !== undefined && raw.expires_in !== null) {
      const expiresIn = typeof raw.expires_in === 'string' ? Number(raw.expires_in) : raw.expires_in;
      if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
        return Date.now() + expiresIn * 1000;
      }
    }

    return 0;
  }

  /**
   * The per-account token, else the legacy `tokens.json`, else `null` when neither exists.
   * A refused or invalid file throws `MicrosoftCredentialFileError` and is not skipped over.
   */
  async loadToken(email?: string): Promise<TokenData | null> {
    const resolvedEmail = await this.resolveEmail(email);

    const raw = await readCredentialFile(this.getTokenPath(resolvedEmail), 'token', rawTokenSchema);
    if (raw !== null) {
      this.cachedToken = this.normalizeToken(raw);
      return this.cachedToken;
    }

    const legacyRaw = await readCredentialFile(this.getLegacyTokenPath(), 'token', rawTokenSchema);
    if (legacyRaw === null) {
      return null;
    }
    this.cachedToken = this.normalizeToken(legacyRaw);
    log.info('Loaded token from legacy tokens.json');
    return this.cachedToken;
  }

  invalidateCachedToken(): void {
    this.cachedToken = null;
  }

  async getAccessToken(email?: string): Promise<string> {
    const resolvedEmail = await this.resolveEmail(email);

    let token = this.cachedToken;
    if (!token) {
      token = await this.loadToken(resolvedEmail);
    }

    if (!token) {
      throw new Error('No Microsoft token found. Please connect your Microsoft account first.');
    }

    const isExpired = token.expires_at < Date.now() + 5 * 60 * 1000;

    if (isExpired && token.refresh_token) {
      const diskToken = await this.loadToken(resolvedEmail);
      if (diskToken && diskToken.expires_at > Date.now() + 5 * 60 * 1000) {
        log.warn('Token refreshed by another process, using disk token', { account: redactEmail(resolvedEmail) });
        return diskToken.access_token;
      }

      if (isRefreshDisabled()) {
        log.warn('Token expired and MICROSOFT_DISABLE_REFRESH=1; signalling auth_required', { account: redactEmail(resolvedEmail) });
        throw new MicrosoftRefreshDisabledError(
          resolvedEmail,
          'token_expired',
          'Microsoft token expired and host has disabled refresh.',
        );
      }

      log.warn('Token expired, attempting refresh', { account: redactEmail(resolvedEmail) });
      try {
        const refreshedToken = await this.refreshToken(
          diskToken?.refresh_token ?? token.refresh_token,
          diskToken?.scope ?? token.scope,
        );
        this.cachedToken = refreshedToken;
        await this.saveToken(resolvedEmail, refreshedToken);
        log.info('Token refreshed successfully', { account: redactEmail(resolvedEmail) });
        return refreshedToken.access_token;
      } catch (err) {
        const fallbackToken = await this.loadToken(resolvedEmail);
        if (fallbackToken && fallbackToken.expires_at > Date.now() + 5 * 60 * 1000) {
          log.warn('Refresh failed but another process refreshed, using disk token', { account: redactEmail(resolvedEmail) });
          return fallbackToken.access_token;
        }
        log.error('Failed to refresh token', { account: redactEmail(resolvedEmail), error: String(err) });
        throw new Error('Microsoft token expired and refresh failed. Please reconnect your account.');
      }
    }

    if (isExpired) {
      throw new Error('Microsoft token expired. Please reconnect your account.');
    }

    return token.access_token;
  }

  private async refreshToken(refreshToken: string, existingScope?: string): Promise<TokenData> {
    const params: Record<string, string> = {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    };

    if (existingScope) {
      params['scope'] = existingScope;
    }

    const response = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      try {
        const errorJson = JSON.parse(errorText);
        log.error('Token refresh failed (AADSTS)', {
          status: response.status,
          error: errorJson.error,
          errorDescription: errorJson.error_description,
          errorCodes: errorJson.error_codes,
          correlationId: errorJson.correlation_id,
        });
      } catch {
        log.error('Token refresh failed', { status: response.status, body: errorText.substring(0, 500) });
      }
      throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? refreshToken,
      expires_at: Date.now() + (data.expires_in ?? 3600) * 1000,
      token_type: data.token_type ?? 'Bearer',
      scope: data.scope,
    };
  }

  private async saveToken(email: string, token: TokenData): Promise<void> {
    const credentialsDir = this.getCredentialsDir();
    await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });

    if (!this.staleTempSweepDone) {
      await sweepStaleTemps(credentialsDir);
      this.staleTempSweepDone = true;
    }

    const tokenPath = this.getTokenPath(email);
    await atomicCredentialWrite(tokenPath, JSON.stringify(token, null, 2), { mode: 0o600 });
  }

  async hasValidToken(email?: string): Promise<boolean> {
    try {
      const resolvedEmail = await this.resolveEmail(email);
      const token = await this.loadToken(resolvedEmail);
      if (!token) return false;
      return token.expires_at > Date.now() || !!token.refresh_token;
    } catch {
      return false;
    }
  }
}
