import { OAuth2Client } from 'google-auth-library';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { getAccountManager } from '../../modules/accounts/index.js';
import { AccountError } from '../../modules/accounts/types.js';
import { findMissingScopes, getServiceNamesForScopes } from '../../utils/scope-hierarchy.js';
import { isAuthHandoffError } from '../../utils/apiError.js';

/**
 * Base error class for Google services
 */
export class GoogleServiceError extends McpError {
  constructor(
    message: string,
    code: string,
    details?: string
  ) {
    super(ErrorCode.InternalError, message, { code, details });
  }
}

/**
 * Configuration interface for Google services
 */
export interface GoogleServiceConfig {
  serviceName: string;
  version: string;
}

/**
 * Base class for Google service implementations.
 * Provides common functionality for authentication, error handling, and client management.
 */
export abstract class BaseGoogleService<TClient> {
  protected oauth2Client?: OAuth2Client;
  private apiClients: Map<string, TClient> = new Map();
  private readonly serviceName: string;

  constructor(config: GoogleServiceConfig) {
    this.serviceName = config.serviceName;
  }

  /**
   * Initializes the service by setting up OAuth2 client
   */
  protected async initialize(): Promise<void> {
    try {
      const accountManager = getAccountManager();
      this.oauth2Client = await accountManager.getAuthClient();
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize service');
    }
  }

  /**
   * Gets an authenticated API client for the service
   * 
   * @param email - The email address to get a client for
   * @param clientFactory - Function to create the specific Google API client
   * @returns The authenticated API client
   */
  protected async getAuthenticatedClient(
    email: string,
    clientFactory: (auth: OAuth2Client) => TClient
  ): Promise<TClient> {
    if (!this.oauth2Client) {
      throw new GoogleServiceError(
        `${this.serviceName} client not initialized`,
        'CLIENT_ERROR',
        'Please ensure the service is initialized'
      );
    }

    const existingClient = this.apiClients.get(email);
    if (existingClient) {
      return existingClient;
    }

    try {
      const accountManager = getAccountManager();
      const tokenStatus = await accountManager.validateToken(email);

      if (tokenStatus.status === 'AUTH_REQUIRED') {
        throw new AccountError(
          `${this.serviceName} authentication required`,
          'AUTH_REQUIRED',
          'Connect Google Workspace to continue'
        );
      }

      // Transient refresh blip (a temporary network error, not a dead grant): surface a
      // retryable error rather than an AUTH_REQUIRED that would push the user to reconnect a
      // grant that's actually fine. formatErrorResponse maps this to a generic retry, not the
      // reconnect CTA. Mirrors the canRetry handling in withTokenRenewal / listAccounts.
      if (!tokenStatus.valid && tokenStatus.canRetry) {
        throw new AccountError(
          `${this.serviceName} token refresh failed temporarily`,
          'TEMPORARY_AUTH_ERROR',
          'Please try again in a moment'
        );
      }

      if (!tokenStatus.valid || !tokenStatus.token) {
        // AccountError (string `code`), not GoogleServiceError: the latter's numeric
        // McpError code is invisible to formatErrorResponse's auth handoff, which is
        // how first-request-of-the-session auth failures degraded to plain errors.
        throw new AccountError(
          `${this.serviceName} authentication required`,
          'AUTH_REQUIRED',
          'Please authenticate the account'
        );
      }

      this.oauth2Client.setCredentials(tokenStatus.token);
      const client = clientFactory(this.oauth2Client);
      this.apiClients.set(email, client);
      return client;
    } catch (error) {
      throw this.handleError(error, 'Failed to get authenticated client');
    }
  }

  /**
   * Common error handler for Google service operations
   * Maps Google API error codes to appropriate MCP error codes
   *
   * Auth-handoff errors (AccountError with code AUTH_REQUIRED /
   * HOST_ORCHESTRATED_AUTH_REQUIRED) pass through unchanged: rewrapping them
   * here would replace the string `code` that server.ts formatErrorResponse
   * keys the structured `auth_required` reconnect handoff on with a mangled
   * `HTTP_AUTH_REQUIRED`, silently degrading an expired grant to a generic
   * failure — the gap the Tasks/Forms/Docs/Slides/Comments service catches
   * used to hit on a first-request auth failure.
   */
  protected handleError(error: unknown, context: string): Error {
    if (isAuthHandoffError(error) && error instanceof Error) {
      return error;
    }
    if (error instanceof GoogleServiceError) {
      return error;
    }

    // Extract status code from Google API errors
    let statusCode: number | undefined;
    let errorMessage = error instanceof Error ? error.message : 'Unknown error';
    
    if (error && typeof error === 'object') {
      // GaxiosError format (googleapis)
      const gaxiosError = error as { code?: number; response?: { status?: number }; message?: string };
      statusCode = gaxiosError.code || gaxiosError.response?.status;
      if (gaxiosError.message) {
        errorMessage = gaxiosError.message;
      }
    }

    // Map status codes to appropriate error codes
    let errorCode = 'SERVICE_ERROR';
    if (statusCode) {
      switch (statusCode) {
        case 400:
          errorCode = 'BAD_REQUEST';
          break;
        case 401:
          errorCode = 'UNAUTHENTICATED';
          break;
        case 403:
          errorCode = 'PERMISSION_DENIED';
          break;
        case 404:
          errorCode = 'NOT_FOUND';
          break;
        case 429:
          errorCode = 'RATE_LIMITED';
          break;
        case 500:
        case 502:
        case 503:
          errorCode = 'SERVER_ERROR';
          break;
        default:
          errorCode = `HTTP_${statusCode}`;
      }
    }

    return new GoogleServiceError(
      context,
      errorCode,
      `Error: ${errorMessage}`
    );
  }

  /**
   * Validates required scopes are present for an operation.
   * 
   * Uses scope hierarchy to check if granted scopes satisfy requirements.
   * For example, 'drive' (full access) satisfies 'drive.file' or 'drive.readonly'.
   * 
   * If scopes are missing, throws an error with user-friendly guidance to re-authenticate.
   */
  protected async validateScopes(email: string, requiredScopes: string[]): Promise<void> {
    try {
      const accountManager = getAccountManager();
      const tokenInfo = await accountManager.validateToken(email);

      // Note: tokenInfo.requiredScopes is misleadingly named - it's actually the GRANTED scopes
      const grantedScopes = tokenInfo.requiredScopes;

      if (!grantedScopes || grantedScopes.length === 0) {
        if (!tokenInfo.valid) {
          // Invalid/expired grant — this is an auth failure, not a scope gap. Keep the
          // reconnect signal (or transient-retry signal) intact: reporting it as a
          // generic SCOPE_ERROR let the swallowing service catches (Tasks/Forms/Docs/
          // Slides/Comments/Sheets) flatten an expired sign-in to a plain string.
          if (tokenInfo.canRetry) {
            throw new AccountError(
              `${this.serviceName} token refresh failed temporarily`,
              'TEMPORARY_AUTH_ERROR',
              'Please try again in a moment'
            );
          }
          throw new AccountError(
            `${this.serviceName} authentication required`,
            'AUTH_REQUIRED',
            tokenInfo.reason || 'Connect Google Workspace to continue'
          );
        }
        throw new GoogleServiceError(
          'No permissions found',
          'SCOPE_ERROR',
          'The Google account connection may be incomplete. ' +
          'Use remove_workspace_account to disconnect, then authenticate_workspace_account to reconnect.'
        );
      }

      // Use hierarchy-aware check (e.g., 'drive' satisfies 'drive.file')
      const missingScopes = findMissingScopes(grantedScopes, requiredScopes);

      if (missingScopes.length > 0) {
        const serviceNames = getServiceNamesForScopes(missingScopes);
        const servicesText = serviceNames.join(', ');
        
        throw new GoogleServiceError(
          `${servicesText} access not granted`,
          'SCOPE_MISSING',
          `This feature requires ${servicesText} permissions that were not granted. ` +
          `To fix this: use remove_workspace_account to disconnect the account, ` +
          `then authenticate_workspace_account to reconnect. The user can then ` +
          `grant the ${servicesText} permission(s) during the consent screen.`
        );
      }
    } catch (error) {
      if (error instanceof GoogleServiceError) {
        throw error;
      }
      throw this.handleError(error, 'Failed to validate permissions');
    }
  }
}
