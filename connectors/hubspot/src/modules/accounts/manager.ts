import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicCredentialWrite } from '../../utils/atomicCredentialWrite.js';
import { withHubSpotCredentialLock } from '../../utils/credentialLock.js';
import logger from '../../utils/logger.js';

const TOKEN_SCHEMA_VERSION = 1;

export interface HubSpotAccountInfo {
  email: string;
  hubId: number;
  status: 'active' | 'expired' | 'error';
  scopeTier?: 'readonly' | 'full';
  grantedScopes?: string[];
}

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  expires_at?: number;
  token_type?: string;
  hub_id?: number;
  user?: string;
  grantedScopes?: string[];
  schemaVersion?: number;
}

export function sanitizeEmail(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-');
}

type ScopeTier = 'readonly' | 'full';

export type StoredAccountRecord = {
  email: string;
  hubId: number;
  scopeTier?: ScopeTier;
  grantedScopes?: string[];
};

type AccountsConfig = {
  accounts: StoredAccountRecord[];
};

class TokenFileError extends Error {
  readonly cause?: unknown;

  constructor(
    message: string,
    public readonly code: string,
    public readonly tokenPath: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'TokenFileError';
    Object.defineProperty(this, 'cause', {
      value: cause,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

export class TokenFileMissingError extends TokenFileError {
  constructor(tokenPath: string, cause?: unknown) {
    super(`Token file not found: ${tokenPath}`, 'TOKEN_FILE_MISSING', tokenPath, cause);
    this.name = 'TokenFileMissingError';
  }
}

export class TokenFileCorruptError extends TokenFileError {
  constructor(tokenPath: string, cause?: unknown) {
    super(`Token file is corrupt: ${tokenPath}`, 'TOKEN_FILE_CORRUPT', tokenPath, cause);
    this.name = 'TokenFileCorruptError';
  }
}

export class TokenFilePermissionDeniedError extends TokenFileError {
  constructor(tokenPath: string, cause?: unknown) {
    super(`Permission denied reading token file: ${tokenPath}`, 'TOKEN_FILE_PERMISSION_DENIED', tokenPath, cause);
    this.name = 'TokenFilePermissionDeniedError';
  }
}

export class TokenFileFutureSchemaError extends TokenFileError {
  constructor(tokenPath: string, public readonly schemaVersion: number) {
    super(
      `Token file schema ${schemaVersion} is newer than supported schema ${TOKEN_SCHEMA_VERSION}`,
      'TOKEN_FILE_FUTURE_SCHEMA',
      tokenPath,
    );
    this.name = 'TokenFileFutureSchemaError';
  }
}

export class TokenFileReadError extends TokenFileError {
  constructor(tokenPath: string, cause?: unknown) {
    super(`Failed to read token file: ${tokenPath}`, 'TOKEN_FILE_READ_ERROR', tokenPath, cause);
    this.name = 'TokenFileReadError';
  }
}

export class TokenPersistFailedError extends Error {
  readonly code = 'TOKEN_PERSIST_FAILED';
  readonly tokenData!: TokenData;
  readonly cause?: unknown;

  constructor(
    public readonly email: string,
    public readonly tokenPath: string,
    tokenData: TokenData,
    cause?: unknown,
  ) {
    super(`Failed to persist HubSpot token for ${email}`);
    this.name = 'TokenPersistFailedError';
    Object.defineProperty(this, 'tokenData', {
      value: tokenData,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    Object.defineProperty(this, 'cause', {
      value: cause,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function isPermissionError(error: unknown): boolean {
  return isErrno(error, 'EACCES') || isErrno(error, 'EPERM');
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object');
  }
  return value as Record<string, unknown>;
}

class AccountManager {
  private configDir: string;
  
  constructor() {
    this.configDir = process.env.HUBSPOT_CONFIG_DIR || path.join(process.env.HOME || '', '.hubspot-mcp');
  }
  
  private get accountsPath(): string {
    return path.join(this.configDir, 'accounts.json');
  }
  
  private get credentialsDir(): string {
    return path.join(this.configDir, 'credentials');
  }

  private getTokenPath(email: string): string {
    return path.join(this.credentialsDir, `${sanitizeEmail(email)}.token.json`);
  }

  getTokenPathForEmail(email: string): string {
    return this.getTokenPath(email);
  }

  getAccountsPathForLock(): string {
    return this.accountsPath;
  }

  private normalizeTokenData(tokenData: TokenData): TokenData {
    return {
      ...tokenData,
      schemaVersion: tokenData.schemaVersion ?? TOKEN_SCHEMA_VERSION,
    };
  }

  private mapTokenReadError(tokenPath: string, error: unknown): TokenFileError {
    if (isErrno(error, 'ENOENT')) {
      return new TokenFileMissingError(tokenPath, error);
    }
    if (isPermissionError(error)) {
      return new TokenFilePermissionDeniedError(tokenPath, error);
    }
    return new TokenFileReadError(tokenPath, error);
  }

  private async readAccountsConfig(): Promise<AccountsConfig> {
    try {
      const data = await fs.readFile(this.accountsPath, 'utf-8');
      const parsed = ensureObject(JSON.parse(data));
      const rawAccounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      const accounts: StoredAccountRecord[] = [];
      for (const entry of rawAccounts) {
        if (!entry || typeof entry !== 'object') continue;
        const item = entry as Record<string, unknown>;
        const email = typeof item.email === 'string' ? item.email : null;
        const hubId = typeof item.hubId === 'number' ? item.hubId : null;
        if (!email || hubId === null) continue;
        const scopeTier = item.scopeTier === 'readonly' || item.scopeTier === 'full'
          ? item.scopeTier
          : undefined;
        const grantedScopes = Array.isArray(item.grantedScopes)
          ? item.grantedScopes.filter((scope): scope is string => typeof scope === 'string')
          : undefined;
        accounts.push({ email, hubId, scopeTier, grantedScopes });
      }
      return { accounts };
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        return { accounts: [] };
      }
      throw error;
    }
  }

  private async writeAccountsConfig(accounts: StoredAccountRecord[]): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    await atomicCredentialWrite(this.accountsPath, JSON.stringify({ accounts }, null, 2), { mode: 0o600 });
  }

  private async writeTokenFile(tokenPath: string, tokenData: TokenData): Promise<void> {
    await atomicCredentialWrite(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
  }

  private async withAccountsLock<T>(fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    return withHubSpotCredentialLock(this.accountsPath, async () => fn());
  }

  private async withAccountsAndEmailLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
    return withHubSpotCredentialLock(this.accountsPath, async () =>
      withHubSpotCredentialLock(this.getTokenPath(email), async () => fn()));
  }
  
  async getAccounts(): Promise<HubSpotAccountInfo[]> {
    try {
      const config = await this.readAccountsConfig();
      
      const results: HubSpotAccountInfo[] = [];
      
      for (const account of config.accounts || []) {
        let status: 'active' | 'expired' | 'error' = 'error';

        try {
          const token = await this.loadToken(account.email);
          // Use 5-minute buffer to match auto-refresh logic
          const bufferMs = 5 * 60 * 1000;
          const isValid = token.expires_at && token.expires_at > (Date.now() + bufferMs);

          if (isValid) {
            status = 'active';
          } else if (token.refresh_token) {
            // Token expired but has refresh_token - will auto-refresh on next use
            status = 'active';
          } else {
            status = 'expired';
          }
        } catch (error) {
          if (error instanceof TokenFileMissingError) {
            status = 'expired';
          } else {
            status = 'error';
          }
        }
        
        results.push({
          email: account.email,
          hubId: account.hubId,
          status,
          scopeTier: account.scopeTier,
          grantedScopes: account.grantedScopes,
        });
      }
      
      return results;
    } catch {
      return [];
    }
  }

  async saveAccounts(
    accounts: StoredAccountRecord[],
    opts: { lockEmails?: string[]; lockAlreadyHeld?: boolean } = {},
  ): Promise<void> {
    const persist = async () => this.writeAccountsConfig(accounts);

    if (opts.lockAlreadyHeld) {
      await persist();
      return;
    }

    const lockEmails = [...new Set((opts.lockEmails ?? accounts.map((account) => account.email))
      .filter((email): email is string => typeof email === 'string' && email.length > 0))]
      .sort();

    await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
    await this.withAccountsLock(async () => {
      if (lockEmails.length === 0) {
        await persist();
        return;
      }

      // Lock each account token path in deterministic order while holding accounts.json lock
      // to prevent cross-process deadlocks and last-writer-wins drops.
      const withAllEmailLocks = async (index: number): Promise<void> => {
        if (index >= lockEmails.length) {
          await persist();
          return;
        }
        const email = lockEmails[index];
        await withHubSpotCredentialLock(this.getTokenPath(email), async () => withAllEmailLocks(index + 1));
      };

      await withAllEmailLocks(0);
    });
  }

  async loadToken(email: string): Promise<TokenData> {
    const tokenPath = this.getTokenPath(email);
    let rawData: string;

    try {
      rawData = await fs.readFile(tokenPath, 'utf-8');
    } catch (error) {
      throw this.mapTokenReadError(tokenPath, error);
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = ensureObject(JSON.parse(rawData));
    } catch (error) {
      throw new TokenFileCorruptError(tokenPath, error);
    }

    const rawSchemaVersion = parsed.schemaVersion;
    if (rawSchemaVersion !== undefined && rawSchemaVersion !== null) {
      if (
        typeof rawSchemaVersion !== 'number' ||
        !Number.isInteger(rawSchemaVersion) ||
        rawSchemaVersion < 1
      ) {
        throw new TokenFileCorruptError(tokenPath, new Error('Invalid schemaVersion in token file'));
      }
      if (rawSchemaVersion > TOKEN_SCHEMA_VERSION) {
        throw new TokenFileFutureSchemaError(tokenPath, rawSchemaVersion);
      }
    }

    const tokenData = parsed as unknown as TokenData;
    if (tokenData.schemaVersion === undefined) {
      // Intentionally no write-back here to avoid stale-overwrite races:
      // another writer may already have persisted a fresher v1 token between read and lock.
      // The next legitimate saveToken call will persist canonical schemaVersion: 1.
      return this.normalizeTokenData(tokenData);
    }

    return tokenData;
  }

  async getToken(email: string): Promise<TokenData> {
    return this.loadToken(email);
  }
  
  async saveToken(email: string, tokenData: TokenData, opts: { lockAlreadyHeld?: boolean } = {}): Promise<void> {
    const normalizedTokenData = this.normalizeTokenData(tokenData);
    await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });
    const tokenPath = this.getTokenPath(email);

    const persist = async () => {
      await this.writeTokenFile(tokenPath, normalizedTokenData);

      const { accounts } = await this.readAccountsConfig();
      const existing = accounts.find((account) => account.email === email);
      const hubId = normalizedTokenData.hub_id || 0;
      if (existing) {
        // Update hubId and grantedScopes, preserve other fields like scopeTier.
        existing.hubId = hubId;
        if (normalizedTokenData.grantedScopes) {
          existing.grantedScopes = normalizedTokenData.grantedScopes;
        }
      } else {
        accounts.push({ email, hubId, grantedScopes: normalizedTokenData.grantedScopes });
      }
      await this.writeAccountsConfig(accounts);
    };

    try {
      if (opts.lockAlreadyHeld) {
        await persist();
      } else {
        await this.withAccountsAndEmailLock(email, persist);
      }
      logger.info(`Saved token for ${email}`);
    } catch (error) {
      if (error instanceof TokenPersistFailedError) {
        throw error;
      }
      throw new TokenPersistFailedError(email, tokenPath, normalizedTokenData, error);
    }
  }
  
  async removeAccount(email: string): Promise<void> {
    const tokenPath = this.getTokenPath(email);
    await fs.mkdir(this.credentialsDir, { recursive: true, mode: 0o700 });

    await this.withAccountsAndEmailLock(email, async () => {
      const { accounts } = await this.readAccountsConfig();
      const updatedAccounts = accounts.filter((account) => account.email !== email);
      await this.writeAccountsConfig(updatedAccounts);

      try {
        await fs.unlink(tokenPath);
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) {
          throw error;
        }
      }
    });

    logger.info(`Removed account ${email}`);
  }

  async hasConfiguredAccountEmail(): Promise<boolean> {
    const configuredEmail = process.env.HUBSPOT_ACCOUNT_EMAIL;
    if (!configuredEmail) {
      return false;
    }

    const accounts = await this.getAccounts();
    const matchingAccount = accounts.find((account) => account.email === configuredEmail);
    if (!matchingAccount) {
      return false;
    }

    try {
      const token = await this.loadToken(configuredEmail);
      return !!token.access_token;
    } catch (error) {
      if (
        error instanceof TokenFileMissingError ||
        error instanceof TokenFileCorruptError ||
        error instanceof TokenFilePermissionDeniedError ||
        error instanceof TokenFileFutureSchemaError ||
        error instanceof TokenFileReadError
      ) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get the email address configured for this MCP instance.
   * In multi-instance mode, each MCP instance handles exactly one account.
   * @throws {Error} if HUBSPOT_ACCOUNT_EMAIL is missing, mismatched, or no accounts exist
   */
  async getCurrentAccountEmail(): Promise<string> {
    const configuredEmail = process.env.HUBSPOT_ACCOUNT_EMAIL;
    if (!configuredEmail) {
      throw new Error('HUBSPOT_ACCOUNT_EMAIL is required for HubSpot MCP tool calls. Set it to a connected account email.');
    }

    const accounts = await this.getAccounts();
    if (accounts.length === 0) {
      throw new Error('No HubSpot accounts connected. Please authenticate first.');
    }

    const matchingAccount = accounts.find((account) => account.email === configuredEmail);
    if (!matchingAccount) {
      throw new Error(
        `HUBSPOT_ACCOUNT_EMAIL (${configuredEmail}) does not match any connected HubSpot account. Please reconnect or select a valid account email.`
      );
    }

    return matchingAccount.email;
  }
}

let managerInstance: AccountManager | null = null;

export function getAccountManager(): AccountManager {
  if (!managerInstance) {
    managerInstance = new AccountManager();
  }
  return managerInstance;
}

export function __resetAccountManagerForTests(): void {
  managerInstance = null;
}
