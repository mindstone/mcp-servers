import logger from '../../utils/logger.js';

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v1/token';
const HUBSPOT_TOKEN_INFO_URL = 'https://api.hubapi.com/oauth/v1/access-tokens';

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

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  hub_id?: number;
  user?: string;
}

interface HubSpotTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
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
    logger.info('Refreshing HubSpot access token');
    
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
    });

    try {
      const response = await fetch(HUBSPOT_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });

      if (!response.ok) {
        throw new HubSpotOAuthError(
          'Failed to refresh token',
          'TOKEN_REFRESH_ERROR',
          'Please re-authenticate the account'
        );
      }

      const data = await response.json() as HubSpotTokenResponse;
      logger.info('Successfully refreshed access token');

      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || refreshToken,
        expires_in: data.expires_in,
        expires_at: Date.now() + data.expires_in * 1000,
        token_type: data.token_type,
      };
    } catch (error) {
      if (error instanceof HubSpotOAuthError) throw error;
      throw new HubSpotOAuthError(
        'Failed to refresh token',
        'TOKEN_REFRESH_ERROR',
        'Please re-authenticate the account'
      );
    }
  }
}

let oauthClientInstance: HubSpotOAuthClient | null = null;

export function getOAuthClient(): HubSpotOAuthClient {
  if (!oauthClientInstance) {
    oauthClientInstance = new HubSpotOAuthClient();
  }
  return oauthClientInstance;
}
