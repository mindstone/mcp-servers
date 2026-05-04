import fs from 'node:fs/promises';
import path from 'node:path';
import type { CredentialLockOptions } from '../../utils/credentialLock.js';
import { withHubSpotCredentialLock } from '../../utils/credentialLock.js';
import logger from '../../utils/logger.js';
import {
  getAccountManager,
  type TokenData,
  TokenPersistFailedError,
} from './manager.js';

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_TOKEN_INFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';
const TOKEN_SCHEMA_VERSION = 1;

// Scope tiers for HubSpot OAuth
export type HubSpotScopeTier = 'readonly' | 'full';

// ⚠️ KEEP IN SYNC with src/main/services/hubspotAuthService.ts
// These scope arrays are duplicated because this MCP server is a standalone TS project
// that cannot import from src/main/. When adding or removing scopes, update BOTH files.

// Base scopes required for all tiers
const HUBSPOT_BASE_SCOPES = [
  'oauth',
  'crm.objects.owners.read',
  'crm.schemas.contacts.read',
  'crm.schemas.companies.read',
  'crm.schemas.deals.read',
];

// Read-only scopes (safe for free HubSpot accounts)
const HUBSPOT_READ_SCOPES = [
  'crm.objects.contacts.read',
  'crm.objects.companies.read',
  'crm.objects.deals.read',
  'crm.objects.products.read',
  'crm.objects.line_items.read',
  'crm.lists.read', // Lists/segments API - requires re-auth for existing users
];

// Optional scopes (requested via optional_scope; some require paid HubSpot)
const HUBSPOT_WRITE_SCOPES = [
  'crm.objects.contacts.write',
  'crm.objects.companies.write',
  'crm.objects.deals.write',
  'crm.objects.products.write',
  'crm.objects.line_items.write',
  'crm.objects.leads.read',
  'crm.objects.leads.write',
  'files', // File manager: upload, manage, attach files to records
  'forms', // Read access to forms and submissions
  'tickets', // Service Hub feature
  'content', // Marketing Hub: analytics, marketing emails
  'automation', // Workflow read-only interrogation (v4 BETA) — in write array for optional_scope pattern
  'cms.knowledge_base.articles.read', // Knowledge Base article read via GraphQL (Service Hub Pro+)
  'collector.graphql_query.execute', // GraphQL API access (Content Hub Pro / Sales Hub Ent / Service Hub Ent)
];

// Full scope set (existing behavior)
const HUBSPOT_FULL_SCOPES = [
  ...HUBSPOT_BASE_SCOPES,
  ...HUBSPOT_READ_SCOPES,
  ...HUBSPOT_WRITE_SCOPES,
];

// Read-only scope set (for free accounts)
const HUBSPOT_READONLY_SCOPES = [
  ...HUBSPOT_BASE_SCOPES,
  ...HUBSPOT_READ_SCOPES,
];

/**
 * Get OAuth scopes for a given tier
 */
export function getScopesForTier(tier: HubSpotScopeTier = 'full'): string[] {
  return tier === 'readonly' ? HUBSPOT_READONLY_SCOPES : HUBSPOT_FULL_SCOPES;
}

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

interface HubSpotTokenErrorResponse {
  error?: string;
  error_description?: string;
  message?: string;
}

interface HubSpotTokenInfo {
  user: string;
  hub_id: number;
  scopes?: string[];
}

export class HubSpotOAuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public resolution?: string
  ) {
    super(message);
    this.name = 'HubSpotOAuthError';
  }
}

export class RefreshTransientError extends Error {
  readonly code = 'REFRESH_TRANSIENT';

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RefreshTransientError';
  }
}

export class RefreshCooldownActiveError extends RefreshTransientError {
  readonly cooldownInduced = true;

  constructor(
    message: string,
    public readonly cooldownUntil: number,
  ) {
    super(message);
    this.name = 'RefreshCooldownActiveError';
  }
}

export class RefreshRateLimitedError extends Error {
  readonly code = 'REFRESH_RATE_LIMITED';

  constructor(
    public readonly retryAfterSeconds: number | undefined,
    public readonly cause?: unknown,
  ) {
    super('HubSpot refresh request was rate limited');
    this.name = 'RefreshRateLimitedError';
  }
}

export class RefreshMalformedResponseError extends Error {
  readonly code = 'REFRESH_MALFORMED_RESPONSE';

  constructor(public readonly cause?: unknown) {
    super('HubSpot refresh response was malformed');
    this.name = 'RefreshMalformedResponseError';
  }
}

export type RefreshAuthRequiredReason = 'refresh_disabled' | 'invalid_grant' | 'missing_refresh_token';

export type RefreshTokenForAccountResult =
  | { status: 'ok'; token: TokenData }
  | { status: 'auth_required'; reason: RefreshAuthRequiredReason };

type RefreshHttpResult =
  | { status: 'ok'; token: TokenData }
  | { status: 'auth_required'; reason: 'invalid_grant' };

interface RefreshCircuitState {
  transientFailures: number[];
  cooldownUntil?: number;
}

interface RefreshMetrics {
  emit: (eventName: string, payload?: Record<string, unknown>) => void;
}

const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 60 * 1000;

const refreshCircuitByEmail = new Map<string, RefreshCircuitState>();
const defaultRefreshMetrics: RefreshMetrics = {
  emit: () => {
    // Stage 4 telemetry stub: real metrics contract lands in Stage 5.
  },
};

let refreshMetrics: RefreshMetrics = defaultRefreshMetrics;
let nowProvider: () => number = () => Date.now();

function getRefreshState(email: string): RefreshCircuitState {
  let state = refreshCircuitByEmail.get(email);
  if (!state) {
    state = { transientFailures: [] };
    refreshCircuitByEmail.set(email, state);
  }
  return state;
}

function clearTransientFailureState(email: string): void {
  const state = getRefreshState(email);
  state.transientFailures = [];
  if (state.cooldownUntil !== undefined && nowProvider() >= state.cooldownUntil) {
    delete state.cooldownUntil;
  }
}

function enforceRefreshCooldown(email: string): void {
  const state = getRefreshState(email);
  if (state.cooldownUntil === undefined) {
    return;
  }

  const now = nowProvider();
  if (now >= state.cooldownUntil) {
    delete state.cooldownUntil;
    return;
  }

  throw new RefreshCooldownActiveError(
    `HubSpot refresh cooldown active for ${email}`,
    state.cooldownUntil,
  );
}

function recordTransientFailure(email: string): void {
  const now = nowProvider();
  const state = getRefreshState(email);
  state.transientFailures = state.transientFailures
    .filter((timestamp) => now - timestamp <= FAILURE_WINDOW_MS);
  state.transientFailures.push(now);

  if (state.transientFailures.length >= FAILURE_THRESHOLD) {
    state.cooldownUntil = now + COOLDOWN_MS;
    state.transientFailures = [];
    refreshMetrics.emit('hubspot.refresh.cooldown', {
      connector: 'hubspot',
      cooldownMs: COOLDOWN_MS,
    });
  }
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (!headerValue || headerValue.trim().length === 0) {
    return undefined;
  }

  const asNumber = Number(headerValue);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber;
  }

  const asDateMs = Date.parse(headerValue);
  if (!Number.isNaN(asDateMs)) {
    return Math.max(0, Math.ceil((asDateMs - nowProvider()) / 1000));
  }

  return undefined;
}

function shouldDisableRefresh(): boolean {
  const refreshDisabled = process.env.HUBSPOT_DISABLE_REFRESH === '1';
  const allowCloudRefresh = process.env.HUBSPOT_ALLOW_CLOUD_REFRESH === '1';
  return refreshDisabled && !allowCloudRefresh;
}

function isTokenResponse(value: unknown): value is HubSpotTokenResponse {
  if (!value || typeof value !== 'object') return false;
  const maybe = value as Partial<HubSpotTokenResponse>;
  return (
    typeof maybe.access_token === 'string' &&
    (maybe.refresh_token === undefined || typeof maybe.refresh_token === 'string') &&
    typeof maybe.expires_in === 'number' &&
    Number.isFinite(maybe.expires_in) &&
    maybe.expires_in > 0 &&
    typeof maybe.token_type === 'string'
  );
}

export class HubSpotOAuthClient {
  private clientId: string;
  private clientSecret: string;

  constructor() {
    const clientId = process.env.HUBSPOT_CLIENT_ID;
    const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new HubSpotOAuthError(
        'Missing OAuth credentials',
        'AUTH_CONFIG_ERROR',
        'HUBSPOT_CLIENT_ID and HUBSPOT_CLIENT_SECRET must be provided'
      );
    }

    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  async getTokenInfo(accessToken: string): Promise<{ user: string; hub_id: number; scopes: string[] }> {
    const response = await fetch(`${HUBSPOT_TOKEN_INFO_URL}/${accessToken}`);
    
    if (!response.ok) {
      throw new HubSpotOAuthError(
        `Failed to get token info: ${response.status}`,
        'TOKEN_INFO_ERROR'
      );
    }
    
    const data = await response.json() as HubSpotTokenInfo;
    return {
      user: data.user,
      hub_id: data.hub_id,
      scopes: Array.isArray(data.scopes) ? data.scopes : [],
    };
  }

  async refreshToken(refreshToken: string): Promise<TokenData> {
    const result = await this.refreshTokenWithMapping(refreshToken);
    if (result.status === 'auth_required') {
      throw new HubSpotOAuthError(
        'HubSpot refresh token is no longer valid',
        'INVALID_GRANT',
        'Please re-authenticate the account',
      );
    }
    return result.token;
  }

  async refreshTokenWithMapping(refreshToken: string): Promise<RefreshHttpResult> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
    });

    let response: Response;
    try {
      response = await fetch(HUBSPOT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
    } catch (error) {
      if (error instanceof RefreshTransientError) {
        throw error;
      }
      throw new RefreshTransientError('HubSpot token refresh request failed', error);
    }

    if (response.status === 429) {
      const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get('retry-after'));
      throw new RefreshRateLimitedError(retryAfterSeconds);
    }

    const responseText = await response.text();
    let parsedBody: unknown;
    if (responseText.length > 0) {
      try {
        parsedBody = JSON.parse(responseText);
      } catch (error) {
        if (response.ok) {
          throw new RefreshMalformedResponseError(error);
        }
      }
    }

    if (!response.ok) {
      const payload = (parsedBody && typeof parsedBody === 'object')
        ? parsedBody as HubSpotTokenErrorResponse
        : undefined;
      if (response.status >= 400 && response.status < 500 && payload?.error === 'invalid_grant') {
        return { status: 'auth_required', reason: 'invalid_grant' };
      }
      if (response.status >= 500) {
        throw new RefreshTransientError(`HubSpot token refresh failed with ${response.status}`);
      }
      throw new RefreshTransientError(`HubSpot token refresh failed with ${response.status}`);
    }

    if (!isTokenResponse(parsedBody)) {
      throw new RefreshMalformedResponseError(new Error('Missing required refresh response fields'));
    }

    logger.info('Successfully refreshed access token');

    return {
      status: 'ok',
      token: {
        access_token: parsedBody.access_token,
        refresh_token: parsedBody.refresh_token || refreshToken,
        expires_in: parsedBody.expires_in,
        expires_at: nowProvider() + parsedBody.expires_in * 1000,
        token_type: parsedBody.token_type,
        schemaVersion: TOKEN_SCHEMA_VERSION,
      },
    };
  }
}

let oauthClientInstance: HubSpotOAuthClient | null = null;

export function getOAuthClient(): HubSpotOAuthClient {
  if (!oauthClientInstance) {
    oauthClientInstance = new HubSpotOAuthClient();
  }
  return oauthClientInstance;
}

export async function refreshTokenForAccount(
  email: string,
  currentToken: TokenData,
  opts: { lockOptions?: CredentialLockOptions } = {},
): Promise<RefreshTokenForAccountResult> {
  if (shouldDisableRefresh()) {
    return { status: 'auth_required', reason: 'refresh_disabled' };
  }

  if (!currentToken.refresh_token) {
    return { status: 'auth_required', reason: 'missing_refresh_token' };
  }

  enforceRefreshCooldown(email);

  const accountManager = getAccountManager();
  const tokenPath = accountManager.getTokenPathForEmail(email);
  const accountsPath = accountManager.getAccountsPathForLock();
  const credentialsDir = path.dirname(tokenPath);
  const oauthClient = getOAuthClient();

  try {
    await fs.mkdir(credentialsDir, { recursive: true, mode: 0o700 });

    const refreshResult = await withHubSpotCredentialLock(accountsPath, async () =>
      withHubSpotCredentialLock(tokenPath, async (assertLockHealthy) => {
        const tokenResult = await oauthClient.refreshTokenWithMapping(currentToken.refresh_token!);
        if (tokenResult.status === 'auth_required') {
          return tokenResult;
        }

        assertLockHealthy();

        const nextToken: TokenData = {
          ...tokenResult.token,
          user: currentToken.user ?? email,
          hub_id: currentToken.hub_id,
          grantedScopes: currentToken.grantedScopes,
          schemaVersion: TOKEN_SCHEMA_VERSION,
        };

        try {
          await accountManager.saveToken(email, nextToken, { lockAlreadyHeld: true });
        } catch (error) {
          if (error instanceof TokenPersistFailedError) {
            throw error;
          }
          throw new TokenPersistFailedError(email, tokenPath, nextToken, error);
        }

        return { status: 'ok', token: nextToken } as const;
      }, opts.lockOptions),
      opts.lockOptions,
    );

    clearTransientFailureState(email);

    if (refreshResult.status === 'auth_required') {
      return { status: 'auth_required', reason: 'invalid_grant' };
    }

    return refreshResult;
  } catch (error) {
    if (error instanceof RefreshTransientError) {
      if (!(error instanceof RefreshCooldownActiveError)) {
        recordTransientFailure(email);
      }
    } else {
      clearTransientFailureState(email);
    }
    throw error;
  }
}

export function __setRefreshNowProviderForTests(nowFn: (() => number) | undefined): void {
  nowProvider = nowFn ?? (() => Date.now());
}

export function __setRefreshMetricsForTests(metrics: RefreshMetrics | undefined): void {
  refreshMetrics = metrics ?? defaultRefreshMetrics;
}

export function __getRefreshStateForTests(email: string): {
  transientFailures: number[];
  cooldownUntil?: number;
} {
  const state = getRefreshState(email);
  return {
    transientFailures: [...state.transientFailures],
    cooldownUntil: state.cooldownUntil,
  };
}

export function __resetRefreshStateForTests(): void {
  refreshCircuitByEmail.clear();
  refreshMetrics = defaultRefreshMetrics;
  nowProvider = () => Date.now();
  oauthClientInstance = null;
}
