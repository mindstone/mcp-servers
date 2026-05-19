import { OAuth2Client } from 'google-auth-library';
import { AccountError } from './types.js';
import logger from '../../utils/logger.js';

export class GoogleOAuthClient {
  private oauth2Client?: OAuth2Client;
  private clientId: string;
  private clientSecret: string;
  private initialized: boolean = false;

  constructor() {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    
    if (!clientId || !clientSecret) {
      throw new AccountError(
        'Missing OAuth credentials',
        'AUTH_CONFIG_ERROR',
        'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be provided'
      );
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
    logger.info('Initializing OAuth client...');
  }

  /**
   * Ensures the OAuth client is initialized without a local callback server.
   * The MCP host owns OAuth URL generation and callback handling.
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized && this.oauth2Client) {
      return;
    }

    this.oauth2Client = new OAuth2Client(this.clientId, this.clientSecret);
    this.initialized = true;
    logger.info('OAuth client initialized for token refresh');
  }

  /**
   * Gets the OAuth2Client, ensuring it's initialized first.
   * For synchronous access (e.g., setting credentials), use getAuthClientSync()
   * but only after ensureInitialized() has been called.
   */
  async getAuthClient(): Promise<OAuth2Client> {
    await this.ensureInitialized();
    return this.oauth2Client!;
  }

  /**
   * Synchronous access to OAuth2Client - only use after initialization is confirmed.
   * @throws Error if called before initialization
   */
  getAuthClientSync(): OAuth2Client {
    if (!this.oauth2Client) {
      throw new AccountError(
        'OAuth client not initialized',
        'AUTH_NOT_READY',
        'Call an async method first to ensure initialization'
      );
    }
    return this.oauth2Client;
  }

  /**
   * Generates the OAuth authorization URL
   * IMPORTANT: When using the generated URL, always use it exactly as returned.
   * Do not attempt to modify, reformat, or reconstruct the URL as this can break
   * the authentication flow. The URL contains carefully encoded parameters that
   * must be preserved exactly as provided.
   */
  async generateAuthUrl(scopes: string[], state?: string): Promise<string> {
    await this.ensureInitialized();
    logger.info('Generating OAuth authorization URL');
    const opts: { access_type: string; scope: string[]; prompt: string; state?: string } = {
      access_type: 'offline',
      scope: scopes,
      prompt: 'consent',
    };
    if (state) {
      opts.state = state;
    }
    const url = this.oauth2Client!.generateAuthUrl(opts);
    logger.debug('Authorization URL generated successfully');
    return url;
  }

  async waitForAuthorizationCode(_sessionId?: string): Promise<string> {
    throw new AccountError(
      'OAuth callback handling is not available in this connector',
      'HOST_ORCHESTRATED_AUTH_REQUIRED',
      'Connect Google Workspace through your MCP host application'
    );
  }

  async getTokenFromCode(code: string): Promise<any> {
    await this.ensureInitialized();
    logger.info('Exchanging authorization code for tokens');
    try {
      const { tokens } = await this.oauth2Client!.getToken(code);
      logger.info('Successfully obtained tokens from auth code');
      return tokens;
    } catch (error) {
      throw new AccountError(
        'Failed to exchange authorization code for tokens',
        'AUTH_CODE_ERROR',
        'Please ensure the authorization code is valid and not expired'
      );
    }
  }

  async refreshToken(refreshToken: string): Promise<any> {
    await this.ensureInitialized();
    logger.info('Refreshing access token');
    try {
      this.oauth2Client!.setCredentials({
        refresh_token: refreshToken
      });
      const { credentials } = await this.oauth2Client!.refreshAccessToken();
      logger.info('Successfully refreshed access token');
      return credentials;
    } catch (error) {
      // Preserve the underlying error message and chain via `cause`. Previously
      // this catch threw a hardcoded `'Failed to refresh token'`, which meant
      // TokenManager's substring detection for `invalid_grant` / `revoked` /
      // `not found` (token.ts ~line 147) was effectively dead code — it
      // matched only against our own wrapper string. Threading the original
      // message through revives that branch, makes pino logs in this child
      // process actually carry Google's error code, and gives downstream
      // callers a recoverable signal for re-auth decisions.
      const underlying = error instanceof Error ? error.message : String(error);
      throw new AccountError(
        `Failed to refresh token: ${underlying}`,
        'TOKEN_REFRESH_ERROR',
        'Please re-authenticate the account',
        error
      );
    }
  }
}
