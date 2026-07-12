import crypto from 'node:crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { Account, AccountsConfig, AccountError, AccountModuleConfig } from './types.js';
import { scopeRegistry } from '../tools/scope-registry.js';
import { TokenManager } from './token.js';
import { atomicCredentialWrite, sweepStaleTemps } from '../../utils/atomicCredentialWrite.js';
import { GoogleOAuthClient } from './oauth.js';
import logger from '../../utils/logger.js';
import { isUnauthorizedError } from './unauthorized.js';

export class AccountManager {
  private readonly accountsPath: string;
  private accounts: Map<string, Account>;
  private tokenManager!: TokenManager;
  private oauthClient!: GoogleOAuthClient;

  constructor(config?: AccountModuleConfig) {
    const defaultPath = process.env.ACCOUNTS_PATH
      ? validateConfiguredAccountsPath(process.env.ACCOUNTS_PATH)
      : path.resolve(process.env.HOME || process.cwd(), '.google-workspace-mcp/accounts.json');
    this.accountsPath = config?.accountsPath || defaultPath;
    this.accounts = new Map();
  }

  async initialize(): Promise<void> {
    logger.info('Initializing AccountManager...');
    this.oauthClient = new GoogleOAuthClient();
    this.tokenManager = new TokenManager(this.oauthClient);
    
    await sweepStaleTemps(path.dirname(this.accountsPath));
    await this.tokenManager.sweepStaleTemps();
    await this.loadAccounts();
    logger.info('AccountManager initialized successfully');
  }

  async listAccounts(): Promise<Account[]> {
    logger.debug('Listing accounts with auth status');
    const accounts = Array.from(this.accounts.values());
    
    // Add auth status to each account and attempt auto-renewal if needed
    for (const account of accounts) {
      const renewalResult = await this.tokenManager.autoRenewToken(account.email);
      
      if (renewalResult.success) {
        account.auth_status = {
          valid: true,
          status: renewalResult.status
        };
      } else if (renewalResult.canRetry) {
        // Transient refresh failure (temporary network error, not a revoked grant):
        // the grant is still good and no reconnect is required. Report valid:true so an
        // agent keying off the boolean doesn't wrongly send the user to reconnect over a
        // blip — this mirrors withTokenRenewal, which proceeds when canRetry is set. The
        // status + reason still carry the transient detail for consumers that look deeper.
        account.auth_status = {
          valid: true,
          status: renewalResult.status,
          reason: renewalResult.reason
        };
      } else {
        // Refresh token invalid/revoked (or otherwise non-retryable) — reconnect required.
        account.auth_status = {
          valid: false,
          status: renewalResult.status,
          reason: renewalResult.reason,
          authUrl: undefined
        };
      }
    }
    
    logger.debug(`Found ${accounts.length} accounts`);
    return accounts;
  }

  /**
   * Wrapper for tool operations that handles token renewal
   * @param email Account email
   * @param operation Function that performs the actual operation
   */
  async withTokenRenewal<T>(
    email: string,
    operation: () => Promise<T>
  ): Promise<T> {
    try {
      // Attempt auto-renewal before operation
      const renewalResult = await this.tokenManager.autoRenewToken(email);
      if (!renewalResult.success) {
        if (renewalResult.canRetry) {
          // If it's a temporary error, let the operation proceed
          // The 401 handler below will catch and retry if needed
          logger.warn('Token renewal failed but may be temporary - proceeding with operation');
        } else {
          // Only require re-auth if refresh token is invalid/revoked
          throw new AccountError(
            'Authentication required',
            renewalResult.status === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'TOKEN_RENEWAL_FAILED',
            renewalResult.reason || 'Please re-authenticate your account'
          );
        }
      }

      // Perform the operation
      return await operation();
    } catch (error) {
      if (isUnauthorizedError(error)) {
        if (isRefreshDisabled()) {
          throw new AccountError(
            'Authentication required',
            'AUTH_REQUIRED',
            'Connect Google Workspace to continue'
          );
        }

        // If we get a 401 during operation, try one more token renewal
        logger.warn('Received 401 during operation, attempting final token renewal');
        const finalRenewal = await this.tokenManager.autoRenewToken(email);
        
        if (finalRenewal.success) {
          // Retry the operation with renewed token
          return await operation();
        }
        
        // Check if we should trigger full OAuth
        if (!finalRenewal.canRetry) {
          // Refresh token is invalid/revoked, need full reauth
          throw new AccountError(
            'Authentication failed',
            finalRenewal.status === 'AUTH_REQUIRED' ? 'AUTH_REQUIRED' : 'TOKEN_RENEWAL_FAILED',
            finalRenewal.reason || 'Please re-authenticate your account'
          );
        } else {
          // Temporary error, let caller handle retry
          throw new AccountError(
            'Token refresh failed temporarily',
            'TEMPORARY_AUTH_ERROR',
            'Please try again later'
          );
        }
      }
      throw error;
    }
  }

  private validateEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private async loadAccounts(): Promise<void> {
    try {
      logger.debug(`Loading accounts from ${this.accountsPath}`);
      // Ensure directory exists with restrictive permissions
      await fs.mkdir(path.dirname(this.accountsPath), { recursive: true, mode: 0o700 });
      
      let data: string;
      try {
        data = await fs.readFile(this.accountsPath, 'utf-8');
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
          // Create empty accounts file if it doesn't exist
          logger.info('Creating new accounts file');
          data = JSON.stringify({ accounts: [] });
          await atomicCredentialWrite(this.accountsPath, data, { mode: 0o600 });
        } else {
          throw new AccountError(
            'Failed to read accounts configuration',
            'ACCOUNTS_READ_ERROR',
            'Please ensure the accounts file is readable'
          );
        }
      }

      try {
        const config = JSON.parse(data) as AccountsConfig;
        this.accounts.clear();
        const slugToEmails = new Map<string, Set<string>>();
        for (const account of config.accounts) {
          const slug = account.email.replace(/[^a-zA-Z0-9]/g, '-');
          const emails = slugToEmails.get(slug) ?? new Set<string>();
          emails.add(account.email);
          slugToEmails.set(slug, emails);
        }
        const collidingEmails = new Set<string>();
        for (const [slug, emails] of slugToEmails) {
          if (emails.size <= 1) continue;
          for (const email of emails) collidingEmails.add(email);
          logger.error({
            event: 'google_workspace_sanitized_slug_collision',
            severity: 'security',
            slug,
            accountCount: emails.size,
            collidingEmailHashes: [...emails].map(hashEmail),
          });
        }
        if (collidingEmails.size > 0) {
          throw new AccountError(
            'Google Workspace account configuration contains colliding account slugs',
            'SANITIZED_SLUG_COLLISION',
            'Resolve the colliding Google account emails before starting this connector'
          );
        }
        for (const account of config.accounts) {
          this.accounts.set(account.email, account);
        }
      } catch (error) {
        if (error instanceof AccountError) {
          throw error;
        }
        throw new AccountError(
          'Failed to parse accounts configuration',
          'ACCOUNTS_PARSE_ERROR',
          'Please ensure the accounts file contains valid JSON'
        );
      }
    } catch (error) {
      if (error instanceof AccountError) {
        throw error;
      }
      throw new AccountError(
        'Failed to load accounts configuration',
        'ACCOUNTS_LOAD_ERROR',
        'Please ensure accounts.json exists and is valid'
      );
    }
  }

  private async saveAccounts(): Promise<void> {
    try {
      const config: AccountsConfig = {
        accounts: Array.from(this.accounts.values())
      };
      await atomicCredentialWrite(this.accountsPath, JSON.stringify(config, null, 2), { mode: 0o600 });
    } catch (error) {
      throw new AccountError(
        'Failed to save accounts configuration',
        'ACCOUNTS_SAVE_ERROR',
        'Please ensure accounts.json is writable',
        error
      );
    }
  }

  async addAccount(email: string, category: string, description: string): Promise<Account> {
    logger.info(`Adding new account: ${email}`);
    if (!this.validateEmail(email)) {
      logger.error(`Invalid email format: ${email}`);
      throw new AccountError(
        'Invalid email format',
        'INVALID_EMAIL',
        'Please provide a valid email address'
      );
    }

    if (this.accounts.has(email)) {
      throw new AccountError(
        'Account already exists',
        'DUPLICATE_ACCOUNT',
        'Use updateAccount to modify existing accounts'
      );
    }

    const account: Account = {
      email,
      category,
      description
    };

    this.accounts.set(email, account);
    await this.saveAccounts();
    return account;
  }

  async updateAccount(email: string, updates: Partial<Omit<Account, 'email'>>): Promise<Account> {
    const account = this.accounts.get(email);
    if (!account) {
      throw new AccountError(
        'Account not found',
        'ACCOUNT_NOT_FOUND',
        'Please ensure the account exists before updating'
      );
    }

    const updatedAccount: Account = {
      ...account,
      ...updates
    };

    this.accounts.set(email, updatedAccount);
    await this.saveAccounts();
    return updatedAccount;
  }

  async removeAccount(email: string): Promise<void> {
    logger.info(`Removing account: ${email}`);
    if (!this.accounts.has(email)) {
      logger.error(`Account not found: ${email}`);
      throw new AccountError(
        'Account not found',
        'ACCOUNT_NOT_FOUND',
        'Cannot remove non-existent account'
      );
    }

    // Delete token first
    await this.tokenManager.deleteToken(email);
    
    // Then remove account
    this.accounts.delete(email);
    await this.saveAccounts();
    logger.info(`Successfully removed account: ${email}`);
  }

  async getAccount(email: string): Promise<Account | null> {
    return this.accounts.get(email) || null;
  }

  /**
   * Get the email address of the first authenticated account.
   * In multi-instance mode, each MCP instance handles exactly one account.
   * @throws {AccountError} if no accounts are authenticated
   */
  async getCurrentAccountEmail(): Promise<string> {
    const accounts = Array.from(this.accounts.values());
    if (accounts.length === 0) {
      throw new AccountError(
        'No authenticated accounts',
        'NO_ACCOUNTS',
        'Please authenticate an account first using authenticate_workspace_account'
      );
    }
    // Return the first (and typically only) account's email
    return accounts[0].email;
  }

  async validateAccount(
    email: string,
    category?: string,
    description?: string
  ): Promise<Account> {
    logger.debug(`Validating account: ${email}`);
    let account = await this.getAccount(email);
    const isNewAccount: boolean = Boolean(!account && category && description);

    try {
      // Handle new account creation
      if (isNewAccount && category && description) {
        logger.info('Creating new account during validation');
        account = await this.addAccount(email, category, description);
      } else if (!account) {
        throw new AccountError(
          'Account not found',
          'ACCOUNT_NOT_FOUND',
          'Please provide category and description for new accounts'
        );
      }

      // Validate token with appropriate flags for new accounts
      const tokenStatus = await this.tokenManager.validateToken(email, isNewAccount);
      
      // Map token status to account auth status
      switch (tokenStatus.status) {
        case 'NO_TOKEN':
          account.auth_status = {
            valid: false,
            status: tokenStatus.status,
            reason: isNewAccount ? 'New account requires authentication' : 'No token found',
            authUrl: undefined
          };
          break;
          
        case 'VALID':
        case 'REFRESHED':
          account.auth_status = {
            valid: true,
            status: tokenStatus.status
          };
          break;
          
        case 'REFRESH_FAILED':
          // Transient refresh blip (canRetry) keeps the grant valid — no reconnect required,
          // mirroring listAccounts. A non-retryable REFRESH_FAILED still reports as invalid.
          account.auth_status = tokenStatus.canRetry
            ? { valid: true, status: tokenStatus.status, reason: tokenStatus.reason }
            : { valid: false, status: tokenStatus.status, reason: tokenStatus.reason, authUrl: undefined };
          break;

        case 'INVALID':
        case 'EXPIRED':
          account.auth_status = {
            valid: false,
            status: tokenStatus.status,
            reason: tokenStatus.reason,
            authUrl: undefined
          };
          break;
          
        case 'ERROR':
        case 'AUTH_REQUIRED':
          account.auth_status = {
            valid: false,
            status: tokenStatus.status,
            reason: tokenStatus.reason || 'Authentication required',
            authUrl: undefined
          };
          break;
      }

      logger.debug(`Account validation complete for ${email}. Status: ${tokenStatus.status}`);
      return account;
      
    } catch (error) {
      logger.error('Account validation failed', error as Error);
      if (error instanceof AccountError) {
        throw error;
      }
      throw new AccountError(
        'Account validation failed',
        'VALIDATION_ERROR',
        'An unexpected error occurred during account validation'
      );
    }
  }

  // OAuth related methods are host-orchestrated in the OSS package.
  async generateAuthUrl(): Promise<string> {
    return '';
  }
  
  async startAuthentication(_email: string): Promise<string> {
    return '';
  }

  getCurrentAuthState(): string | null {
    return null;
  }

  async waitForAuthorizationCode(sessionId?: string): Promise<string> {
    return this.oauthClient.waitForAuthorizationCode(sessionId);
  }

  async getTokenFromCode(code: string): Promise<any> {
    const token = await this.oauthClient.getTokenFromCode(code);
    return token;
  }

  async refreshToken(refreshToken: string): Promise<any> {
    return this.oauthClient.refreshToken(refreshToken);
  }

  async getAuthClient() {
    return this.oauthClient.getAuthClient();
  }

  // Token related methods
  async validateToken(email: string, skipValidationForNew: boolean = false) {
    return this.tokenManager.validateToken(email, skipValidationForNew);
  }

  async saveToken(email: string, tokenData: any) {
    return this.tokenManager.saveToken(email, tokenData);
  }
}

function isRefreshDisabled(): boolean {
  return process.env.GOOGLE_WORKSPACE_DISABLE_REFRESH === '1';
}

function hashEmail(email: string): string {
  return crypto.createHash('sha256').update(email).digest('hex').slice(0, 12);
}

function validateConfiguredAccountsPath(rawPath: string): string {
  const absolutePath = path.resolve(rawPath);
  let stats: fsSync.Stats;
  try {
    stats = fsSync.lstatSync(absolutePath);
  } catch (error) {
    throw new AccountError(
      'ACCOUNTS_PATH is invalid',
      'CONFIG_PATH_INVALID',
      'ACCOUNTS_PATH must point to an existing accounts.json file',
      error
    );
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new AccountError(
      'ACCOUNTS_PATH is invalid',
      'CONFIG_PATH_INVALID',
      'ACCOUNTS_PATH must point to a real accounts.json file, not a symlink or directory'
    );
  }

  return fsSync.realpathSync.native(absolutePath);
}
