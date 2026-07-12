import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { AccountError, TokenStatus, TokenRenewalResult } from './types.js';
import { GoogleOAuthClient } from './oauth.js';
import logger from '../../utils/logger.js';
import { atomicCredentialWrite, sweepStaleTemps } from '../../utils/atomicCredentialWrite.js';
import { isRefreshTokenInvalidError } from './unauthorized.js';

/**
 * Manages OAuth token operations.
 * Focuses on basic token storage, retrieval, and refresh.
 * Auth issues are handled via 401 responses rather than pre-validation.
 */
export class TokenManager {
  private readonly credentialsPath: string;
  private oauthClient?: GoogleOAuthClient;
  private readonly TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000; // 5 minutes buffer

  constructor(oauthClient?: GoogleOAuthClient) {
    this.credentialsPath = process.env.CREDENTIALS_PATH
      ? validateConfiguredDirectoryPath(process.env.CREDENTIALS_PATH, 'CREDENTIALS_PATH')
      : path.resolve(process.env.HOME || process.cwd(), '.google-workspace-mcp/credentials');
    this.oauthClient = oauthClient;
  }

  setOAuthClient(client: GoogleOAuthClient) {
    this.oauthClient = client;
  }

  private getTokenPath(email: string): string {
    const sanitizedEmail = email.replace(/[^a-zA-Z0-9]/g, '-');
    return path.join(this.credentialsPath, `${sanitizedEmail}.token.json`);
  }

  async saveToken(email: string, tokenData: any): Promise<void> {
    logger.info(`Saving token for account: ${email}`);
    try {
      // Ensure base credentials directory exists with restrictive permissions
      await fs.mkdir(this.credentialsPath, { recursive: true, mode: 0o700 });
      const tokenPath = this.getTokenPath(email);
      await atomicCredentialWrite(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
      logger.debug(`Token saved successfully at: ${tokenPath}`);
    } catch (error) {
      throw new AccountError(
        'Failed to save token',
        'TOKEN_SAVE_ERROR',
        'Please ensure the credentials directory is writable',
        error
      );
    }
  }

  async loadToken(email: string): Promise<any> {
    logger.debug(`Loading token for account: ${email}`);
    try {
      const tokenPath = this.getTokenPath(email);
      const data = await fs.readFile(tokenPath, 'utf-8');
      return JSON.parse(data);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        // File doesn't exist - return null to trigger OAuth flow
        return null;
      }
      throw new AccountError(
        'Failed to load token',
        'TOKEN_LOAD_ERROR',
        'Please ensure the token file exists and is readable'
      );
    }
  }


  async sweepStaleTemps(): Promise<void> {
    await sweepStaleTemps(this.credentialsPath);
  }

  private isRefreshDisabled(): boolean {
    const value = process.env.GOOGLE_WORKSPACE_DISABLE_REFRESH;
    return !!value && value !== '0' && value.toLowerCase() !== 'false';
  }

  private authRequiredResult(reason = 'Google Workspace needs to be reconnected'): TokenRenewalResult {
    return {
      success: false,
      status: 'AUTH_REQUIRED',
      reason,
      canRetry: false
    };
  }

  async deleteToken(email: string): Promise<void> {
    logger.info(`Deleting token for account: ${email}`);
    try {
      const tokenPath = this.getTokenPath(email);
      await fs.unlink(tokenPath);
      logger.debug('Token file deleted successfully');
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
        throw new AccountError(
          'Failed to delete token',
          'TOKEN_DELETE_ERROR',
          'Please ensure you have permission to delete the token file'
        );
      }
    }
  }

  /**
   * Refreshes the access token, retrying once on a non-invalid_grant failure.
   *
   * Shared by autoRenewToken and validateToken so the retry + failure-classification
   * logic can't drift between the two paths. On success the refreshed token is persisted
   * (scope + refresh_token preserved, since Google omits them on refresh). The outcome
   * distinguishes a dead grant (invalidGrant: true → reconnect) from a transient blip
   * (invalidGrant: false → retryable), including the case where a transient first attempt
   * is followed by an invalid_grant on retry.
   *
   * Callers must have already established that token.refresh_token and this.oauthClient exist.
   */
  private async refreshWithRetry(
    email: string,
    token: any
  ): Promise<{ ok: true; token: any } | { ok: false; invalidGrant: boolean }> {
    const attemptRefresh = async () => {
      const newToken = await this.oauthClient!.refreshToken(token.refresh_token);
      // Preserve original scope and refresh_token - Google doesn't return these on refresh
      newToken.scope = newToken.scope || token.scope;
      newToken.refresh_token = newToken.refresh_token || token.refresh_token;
      await this.saveToken(email, newToken);
      return newToken;
    };

    try {
      return { ok: true, token: await attemptRefresh() };
    } catch (error) {
      if (isRefreshTokenInvalidError(error)) {
        logger.error('Refresh token is invalid or revoked');
        return { ok: false, invalidGrant: true };
      }
      // Not a refresh-token problem — a transient blip. Try once more.
      try {
        logger.warn('First refresh attempt failed, trying once more');
        return { ok: true, token: await attemptRefresh() };
      } catch (secondError) {
        // Re-classify the retry failure: a transient blip followed by an invalid_grant is
        // still a dead grant, so it must not be mislabelled as retryable.
        if (isRefreshTokenInvalidError(secondError)) {
          logger.error('Refresh token is invalid or revoked (surfaced on retry)');
          return { ok: false, invalidGrant: true };
        }
        logger.error('Both refresh attempts failed, but refresh token may still be valid');
        return { ok: false, invalidGrant: false };
      }
    }
  }

  /**
   * Basic token validation - just checks if token exists and isn't expired.
   * No scope validation - auth issues handled via 401 responses.
   */
  /**
   * Attempts to automatically renew a token if it's expired or near expiry
   * Returns the renewal result and new token if successful
   */
  async autoRenewToken(email: string): Promise<TokenRenewalResult> {
    logger.debug(`Attempting auto-renewal for account: ${email}`);
    
    try {
      const token = await this.loadToken(email);
      
      if (!token) {
        return {
          success: false,
          status: 'NO_TOKEN',
          reason: 'No token found'
        };
      }

      if (!token.expiry_date) {
        return {
          success: false,
          status: 'INVALID',
          reason: 'Invalid token format'
        };
      }

      // Check if token is expired or will expire soon
      const now = Date.now();
      if (token.expiry_date <= now + this.TOKEN_EXPIRY_BUFFER_MS) {
        if (this.isRefreshDisabled()) {
          logger.info('Token refresh disabled by GOOGLE_WORKSPACE_DISABLE_REFRESH');
          return this.authRequiredResult('Connect Google Workspace to continue');
        }

        if (!token.refresh_token || !this.oauthClient) {
          return {
            success: false,
            status: 'REFRESH_FAILED',
            reason: 'No refresh token or OAuth client available'
          };
        }

        const outcome = await this.refreshWithRetry(email, token);
        if (outcome.ok) {
          logger.info('Token refreshed successfully');
          return {
            success: true,
            status: 'REFRESHED',
            token: outcome.token
          };
        }
        if (outcome.invalidGrant) {
          // Refresh token is invalid, need full reauth
          return {
            success: false,
            status: 'AUTH_REQUIRED',
            reason: 'Refresh token is invalid or revoked',
            canRetry: false
          };
        }
        return {
          success: false,
          status: 'REFRESH_FAILED',
          reason: 'Token refresh failed, temporary error',
          canRetry: true
        };
      }

      // Token is still valid
      return {
        success: true,
        status: 'VALID',
        token
      };
    } catch (error) {
      logger.error('Token auto-renewal error', error as Error);
      return {
        success: false,
        status: 'ERROR',
        reason: 'Token auto-renewal failed'
      };
    }
  }

  async validateToken(email: string, skipValidationForNew: boolean = false): Promise<TokenStatus> {
    logger.debug(`Validating token for account: ${email}`);
    
    try {
      const token = await this.loadToken(email);
      
      if (!token) {
        logger.debug('No token found');
        return {
          valid: false,
          status: 'NO_TOKEN',
          reason: 'No token found'
        };
      }

      // Skip validation if this is a new account setup
      if (skipValidationForNew) {
        logger.debug('Skipping validation for new account setup');
        return {
          valid: true,
          status: 'VALID',
          token
        };
      }

      if (!token.expiry_date) {
        logger.debug('Token missing expiry date');
        return {
          valid: false,
          status: 'INVALID',
          reason: 'Invalid token format'
        };
      }

      if (token.expiry_date < Date.now()) {
        logger.debug('Token has expired, attempting refresh');
        if (this.isRefreshDisabled()) {
          logger.info('Token validation found expired token with refresh disabled');
          return {
            valid: false,
            status: 'AUTH_REQUIRED',
            reason: 'Connect Google Workspace to continue'
          };
        }

        if (token.refresh_token && this.oauthClient) {
          // Retry-once + failure classification lives in refreshWithRetry (shared with
          // autoRenewToken). A single transient network blip shouldn't be reported as a
          // dead grant; the canRetry flag lets callers (e.g. BaseGoogleService) surface a
          // retryable error instead of demanding a reconnect.
          const outcome = await this.refreshWithRetry(email, token);
          if (outcome.ok) {
            logger.info('Token refreshed successfully');
            return {
              valid: true,
              status: 'REFRESHED',
              token: outcome.token,
              requiredScopes: outcome.token.scope ? outcome.token.scope.split(' ') : undefined
            };
          }
          if (outcome.invalidGrant) {
            return {
              valid: false,
              status: 'AUTH_REQUIRED',
              reason: 'Refresh token is invalid or revoked'
            };
          }
          return {
            valid: false,
            status: 'REFRESH_FAILED',
            reason: 'Token refresh failed, temporary error',
            canRetry: true
          };
        }
        logger.debug('No refresh token available');
        return {
          valid: false,
          status: 'EXPIRED',
          reason: 'Token expired and no refresh token available'
        };
      }

      logger.debug('Token is valid');
      return {
        valid: true,
        status: 'VALID',
        token,
        requiredScopes: token.scope ? token.scope.split(' ') : undefined
      };
    } catch (error) {
      logger.error('Token validation error', error as Error);
      return {
        valid: false,
        status: 'ERROR',
        reason: 'Token validation failed'
      };
    }
  }
}

function validateConfiguredDirectoryPath(rawPath: string, envName: string): string {
  const absolutePath = path.resolve(rawPath);
  let stats: fsSync.Stats;
  try {
    stats = fsSync.lstatSync(absolutePath);
  } catch (error) {
    throw new AccountError(
      `${envName} is invalid`,
      'CONFIG_PATH_INVALID',
      `${envName} must point to an existing directory`,
      error
    );
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new AccountError(
      `${envName} is invalid`,
      'CONFIG_PATH_INVALID',
      `${envName} must point to a real directory, not a symlink or file`
    );
  }

  return fsSync.realpathSync.native(absolutePath);
}
