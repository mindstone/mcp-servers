#!/usr/bin/env node
/**
 * Zendesk MCP Server
 *
 * Provides Zendesk Support integration via Model Context Protocol.
 * Supports API token authentication (primary) and OAuth 2.0 (legacy/future).
 *
 * Environment variables:
 * - ZENDESK_CONFIG_PATH: Path to config directory containing accounts.json and credentials/
 * - ZENDESK_CLIENT_ID: OAuth client ID (for token refresh, OAuth only)
 * - ZENDESK_CLIENT_SECRET: OAuth client secret (for token refresh, OAuth only)
 * - MCP_HOST_BRIDGE_STATE: Path to host app bridge state file for credential management (optional)
 *
 * Authentication:
 * - API token: Basic auth with email/token:apiToken (primary)
 * - OAuth 2.0: Bearer tokens with automatic refresh (legacy/future)
 * API Rate Limits: ~400 requests/min (varies by plan)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Configuration
const CONFIG_PATH = process.env.ZENDESK_CONFIG_PATH || path.join(os.homedir(), '.mcp', 'zendesk');
const BRIDGE_STATE_PATH = process.env.MCP_HOST_BRIDGE_STATE || process.env.MINDSTONE_REBEL_BRIDGE_STATE;

// OAuth credentials (for token refresh)
const ZENDESK_CLIENT_ID = process.env.ZENDESK_CLIENT_ID;
const ZENDESK_CLIENT_SECRET = process.env.ZENDESK_CLIENT_SECRET;

// Token refresh buffer - refresh if token expires within this many milliseconds
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const REQUEST_TIMEOUT_MS = 30_000;
const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

// Types
interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  expires_at: number; // Unix timestamp in ms
  token_type: string;
  subdomain: string;
  email?: string;
}

interface AccountInfo {
  subdomain: string;
  email: string;
  apiToken?: string;
}

interface AccountsConfig {
  accounts: AccountInfo[];
  defaultSubdomain?: string;
}

interface ZendeskAccount {
  subdomain: string;
  email?: string;
  apiToken?: string;
  authType: 'api-token' | 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

interface BridgeState {
  port: number;
  token: string;
}

function assertValidSubdomain(subdomain: string): void {
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new Error(`Invalid Zendesk subdomain: ${subdomain}`);
  }
}

function resolveTempOutputPath(outputPath: string): string {
  const resolved = path.resolve(outputPath);
  if (!resolved.startsWith(path.resolve(os.tmpdir()))) {
    throw new Error('output_path must be within the temp directory');
  }
  return resolved;
}

// Account management
let accountsConfig: AccountsConfig = { accounts: [] };
let accounts: Map<string, ZendeskAccount> = new Map();

/**
 * Load accounts from accounts.json and OAuth tokens from credentials/ directory.
 * Called on every getAccount() call to support hot-reload of new accounts.
 */
function loadAccounts(): void {
  const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
  const credentialsDir = path.join(CONFIG_PATH, 'credentials');
  
  // Load accounts.json
  try {
    if (fs.existsSync(accountsPath)) {
      const raw = fs.readFileSync(accountsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.accounts)) {
        accountsConfig = {
          accounts: parsed.accounts,
          defaultSubdomain: typeof parsed.defaultSubdomain === 'string' ? parsed.defaultSubdomain : undefined,
        };
      } else {
        accountsConfig = { accounts: [] };
      }
    }
  } catch {
    accountsConfig = { accounts: [] };
  }
  
  // Load OAuth tokens from credentials/<subdomain>.token.json files
  accounts.clear();
  
  try {
    if (fs.existsSync(credentialsDir)) {
      const files = fs.readdirSync(credentialsDir);
      for (const file of files) {
        if (file.endsWith('.token.json')) {
          const subdomain = file.replace('.token.json', '');
          const tokenPath = path.join(credentialsDir, file);
          try {
            assertValidSubdomain(subdomain);
            const tokenRaw = fs.readFileSync(tokenPath, 'utf8');
            const tokenData: TokenData = JSON.parse(tokenRaw);
            
            accounts.set(subdomain, {
              subdomain,
              email: tokenData.email,
              authType: 'oauth',
              accessToken: tokenData.access_token,
              refreshToken: tokenData.refresh_token,
              expiresAt: tokenData.expires_at,
            });
            
            // Update accounts.json if this subdomain isn't listed
            const existingAccount = accountsConfig.accounts.find(a => a.subdomain === subdomain);
            if (!existingAccount && tokenData.email) {
              accountsConfig.accounts.push({ subdomain, email: tokenData.email });
              if (!accountsConfig.defaultSubdomain) {
                accountsConfig.defaultSubdomain = subdomain;
              }
            }
          } catch (tokenError) {
            console.error(`[Zendesk] Failed to load token for ${subdomain}:`, tokenError);
          }
        }
      }
    }
  } catch (dirError) {
    console.error('[Zendesk] Failed to read credentials directory:', dirError);
  }

  // Load API token accounts from accounts.json
  for (const account of accountsConfig.accounts) {
    try {
      assertValidSubdomain(account.subdomain);
      if (account.apiToken && !accounts.has(account.subdomain)) {
        // API token account — no OAuth token file needed
        accounts.set(account.subdomain, {
          subdomain: account.subdomain,
          email: account.email,
          apiToken: account.apiToken,
          authType: 'api-token',
          accessToken: '', // unused for API token auth
          expiresAt: Infinity, // API tokens don't expire
        });
      }
    } catch (error) {
      console.error('[Zendesk] Failed to load account:', error);
    }
  }
}

/**
 * Save token data to credentials/<subdomain>.token.json
 */
function saveToken(subdomain: string, tokenData: TokenData): void {
  const credentialsDir = path.join(CONFIG_PATH, 'credentials');
  try {
    if (!fs.existsSync(credentialsDir)) {
      fs.mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    }
    const tokenPath = path.join(credentialsDir, `${subdomain}.token.json`);
    fs.writeFileSync(tokenPath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error(`[Zendesk] Failed to save token for ${subdomain}:`, error);
  }
}

/**
 * Refresh the OAuth token for a subdomain.
 * Returns true if refresh succeeded, false otherwise.
 */
async function refreshToken(subdomain: string): Promise<boolean> {
  assertValidSubdomain(subdomain);
  const account = accounts.get(subdomain);
  if (!account || !account.refreshToken) {
    console.error(`[Zendesk] Cannot refresh token for ${subdomain}: no refresh token available`);
    return false;
  }
  
  if (!ZENDESK_CLIENT_ID || !ZENDESK_CLIENT_SECRET) {
    console.error('[Zendesk] Cannot refresh token: missing ZENDESK_CLIENT_ID or ZENDESK_CLIENT_SECRET');
    return false;
  }
  
  try {
    const tokenUrl = `https://${subdomain}.zendesk.com/oauth/tokens`;
    // Zendesk OAuth requires application/x-www-form-urlencoded, not JSON
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: ZENDESK_CLIENT_ID,
      client_secret: ZENDESK_CLIENT_SECRET,
      refresh_token: account.refreshToken,
      scope: 'read write',
    });
    const response = await fetch(tokenUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[Zendesk] Token refresh failed for ${subdomain}:`, response.status, errorText);
      return false;
    }
    
    const tokenResponse = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      token_type: string;
    };
    
    // Calculate new expiration time
    const expiresAt = Date.now() + (tokenResponse.expires_in * 1000);
    
    // Update in-memory account
    account.accessToken = tokenResponse.access_token;
    if (tokenResponse.refresh_token) {
      account.refreshToken = tokenResponse.refresh_token;
    }
    account.expiresAt = expiresAt;
    
    // Persist to disk
    const tokenData: TokenData = {
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || account.refreshToken,
      expires_in: tokenResponse.expires_in,
      expires_at: expiresAt,
      token_type: tokenResponse.token_type,
      subdomain,
      email: account.email,
    };
    saveToken(subdomain, tokenData);
    
    console.error(`[Zendesk] Token refreshed for ${subdomain}, expires in ${tokenResponse.expires_in}s`);
    return true;
  } catch (error) {
    console.error(`[Zendesk] Token refresh error for ${subdomain}:`, error);
    return false;
  }
}

/**
 * Get the appropriate Authorization header for an account.
 * API token accounts use Basic auth; OAuth accounts use Bearer token.
 */
function getAuthHeader(account: ZendeskAccount): string {
  if (account.authType === 'api-token' && account.apiToken) {
    // Zendesk API token auth: email/token:apiToken, Base64 encoded
    return `Basic ${Buffer.from(`${account.email}/token:${account.apiToken}`).toString('base64')}`;
  }
  // OAuth Bearer token
  return `Bearer ${account.accessToken}`;
}

/**
 * Check if a token needs refresh (expired or within buffer window).
 */
function tokenNeedsRefresh(account: ZendeskAccount): boolean {
  if (account.authType === 'api-token') return false; // API tokens don't expire
  const now = Date.now();
  return account.expiresAt <= now + TOKEN_REFRESH_BUFFER_MS;
}

/**
 * Get token status for an account.
 */
function getTokenStatus(account: ZendeskAccount): 'active' | 'expired' | 'needs-refresh' {
  if (account.authType === 'api-token') return 'active'; // API tokens don't expire
  const now = Date.now();
  if (account.expiresAt <= now) {
    return 'expired';
  }
  if (account.expiresAt <= now + TOKEN_REFRESH_BUFFER_MS) {
    return 'needs-refresh';
  }
  return 'active';
}

/**
 * Get an account by subdomain, with hot-reload support.
 * Also handles automatic token refresh if needed.
 */
async function getAccount(subdomain?: string): Promise<ZendeskAccount | undefined> {
  // Hot-reload: always reload accounts from disk
  loadAccounts();
  
  if (accounts.size === 0) return undefined;
  
  let account: ZendeskAccount | undefined;
  
  if (subdomain) {
    account = accounts.get(subdomain);
  } else {
    // Return default or first account
    const defaultSub = accountsConfig.defaultSubdomain;
    if (defaultSub) {
      account = accounts.get(defaultSub);
    }
    if (!account) {
      // Get first available
      account = accounts.values().next().value;
    }
  }
  
  if (!account) return undefined;
  
  // Auto-refresh if token is expired or near expiry
  if (tokenNeedsRefresh(account)) {
    console.error(`[Zendesk] Token for ${account.subdomain} needs refresh (expires at ${new Date(account.expiresAt).toISOString()})`);
    const refreshed = await refreshToken(account.subdomain);
    if (!refreshed) {
      console.error(`[Zendesk] Token refresh failed for ${account.subdomain}`);
      // Return the account anyway - the API call will fail with 401 and provide a clear error
    }
  }
  
  return account;
}

// Initialize accounts on startup
loadAccounts();

// Bridge communication
const loadBridgeState = (): BridgeState | null => {
  if (!BRIDGE_STATE_PATH) return null;
  try {
    const raw = fs.readFileSync(BRIDGE_STATE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const bridgeRequest = async (
  urlPath: string,
  body: Record<string, unknown>
): Promise<{ success: boolean; warning?: string; error?: string }> => {
  const bridge = loadBridgeState();
  if (!bridge) {
    return { success: false, error: 'Bridge not available' };
  }
  const response = await fetch(`http://127.0.0.1:${bridge.port}${urlPath}`, {
    method: 'POST',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridge.token}`,
    },
    body: JSON.stringify(body),
  });
  return response.json() as Promise<{ success: boolean; warning?: string; error?: string }>;
};

// Zendesk API client
interface ZendeskFetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

/**
 * Parse Retry-After header value to milliseconds.
 * Supports seconds (integer) and HTTP-date formats.
 * Clamps to [0, 30000] ms, defaults to 1000ms on invalid/missing values.
 */
function parseRetryAfterMs(header: string | null): number {
  if (!header) return 1000;

  const seconds = parseInt(header, 10);
  if (!isNaN(seconds)) {
    return Math.max(0, Math.min(seconds * 1000, 30000));
  }

  const dateMs = Date.parse(header);
  if (!isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.max(0, Math.min(delta, 30000));
  }

  return 1000;
}

async function zendeskFetch<T>(
  account: ZendeskAccount,
  endpoint: string,
  options: ZendeskFetchOptions = {}
): Promise<T> {
  const { params, ...fetchOptions } = options;
  const method = (options.method ?? 'GET').toUpperCase();
  assertValidSubdomain(account.subdomain);
  
  // Build URL with query params
  let url = `https://${account.subdomain}.zendesk.com/api/v2${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        searchParams.append(key, String(value));
      }
    }
    const queryString = searchParams.toString();
    if (queryString) {
      url += (url.includes('?') ? '&' : '?') + queryString;
    }
  }

  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Build auth header fresh each attempt (may change after 401 refresh)
    const authHeader = getAuthHeader(account);
    
    console.error(`[Zendesk API] Calling ${url} with subdomain=${account.subdomain}`);

    const response = await fetch(url, {
      ...fetchOptions,
      signal: fetchOptions.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...fetchOptions.headers,
      },
    });

    // Handle rate limiting with retry for GET requests
    if (response.status === 429) {
      if (method !== 'GET' || attempt >= maxRetries) {
        const retryAfter = response.headers.get('Retry-After');
        const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
        throw new ZendeskError(
          `Rate limited. Please wait ${waitTime} before retrying.`,
          'RATE_LIMITED',
          `Wait ${waitTime} and try again. Zendesk limits vary by plan (~400 req/min typical).`
        );
      }

      const waitMs = parseRetryAfterMs(response.headers.get('Retry-After'));
      const jitter = Math.floor(Math.random() * 500);
      console.error(`[Zendesk API] Rate limited, retrying in ${waitMs + jitter}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, waitMs + jitter));
      continue;
    }

    // Handle auth errors - try refresh once if we get 401
    if (response.status === 401) {
      // API token accounts can't refresh — fail immediately with clear error
      if (account.authType === 'api-token') {
        throw new ZendeskError(
          'Authentication failed',
          'AUTH_FAILED',
          'API token is invalid or revoked. Check your Zendesk API token and email, or reconnect in your MCP host app settings.'
        );
      }

      console.error(`[Zendesk API] 401 Unauthorized for ${url}, attempting token refresh`);
      
      // Try to refresh the OAuth token
      const refreshed = await refreshToken(account.subdomain);
      if (refreshed) {
        // Reload the account to get the new token
        const refreshedAccount = accounts.get(account.subdomain);
        if (refreshedAccount) {
          // Retry the request with the new token
          console.error(`[Zendesk API] Retrying request with refreshed token`);
          const retryResponse = await fetch(url, {
            ...fetchOptions,
            signal: fetchOptions.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            headers: {
              Authorization: getAuthHeader(refreshedAccount),
              'Content-Type': 'application/json',
              Accept: 'application/json',
              ...fetchOptions.headers,
            },
          });
          
          if (retryResponse.ok || retryResponse.status === 204) {
            if (retryResponse.status === 204) {
              return {} as T;
            }
            return retryResponse.json() as Promise<T>;
          }
          
          if (retryResponse.status === 401) {
            throw new ZendeskError(
              'Authentication failed after token refresh',
              'AUTH_FAILED',
              'OAuth token is invalid. Please reconnect your Zendesk account in your MCP host app settings.'
            );
          }

          // Post-refresh request failed with non-auth error (429, 403, 5xx etc.)
          // Surface the real error instead of masking as AUTH_FAILED
          const postRefreshErrorText = await retryResponse.text().catch(() => '');
          console.error(`Zendesk API error after token refresh (${retryResponse.status}):`, postRefreshErrorText);

          if (retryResponse.status === 429) {
            const retryAfter = retryResponse.headers.get('Retry-After');
            const waitTime = retryAfter ? `${retryAfter} seconds` : 'a moment';
            throw new ZendeskError(
              `Rate limited. Please wait ${waitTime} before retrying.`,
              'RATE_LIMITED',
              `Wait ${waitTime} and try again. Zendesk limits vary by plan (~400 req/min typical).`
            );
          }

          const postRefreshStatusMsg = retryResponse.status === 403 ? 'Forbidden - check permissions'
            : retryResponse.status === 422 ? 'Validation error - check request parameters'
            : retryResponse.status >= 500 ? 'Zendesk server error - try again later'
            : 'Request failed';
          throw new ZendeskError(
            `Zendesk API error (${retryResponse.status}): ${postRefreshStatusMsg}`,
            'API_ERROR',
            'Check the request parameters and try again.'
          );
        }
      }
      
      throw new ZendeskError(
        'Authentication failed',
        'AUTH_FAILED',
        'OAuth token is expired or invalid. Please reconnect your Zendesk account in your MCP host app settings.'
      );
    }

    // Handle not found
    if (response.status === 404) {
      throw new ZendeskError(
        'Resource not found',
        'NOT_FOUND',
        'The requested resource does not exist or you do not have permission to access it.'
      );
    }

    // Handle other errors - sanitize to avoid leaking sensitive data
    if (!response.ok) {
      // Log the full error for debugging but don't expose to LLM
      const errorText = await response.text().catch(() => '');
      console.error(`Zendesk API error (${response.status}):`, errorText);
      
      // Provide helpful but sanitized error message
      const statusMessage = response.status === 403 ? 'Forbidden - check permissions'
        : response.status === 422 ? 'Validation error - check request parameters'
        : response.status >= 500 ? 'Zendesk server error - try again later'
        : 'Request failed';
      
      throw new ZendeskError(
        `Zendesk API error (${response.status}): ${statusMessage}`,
        'API_ERROR',
        'Check the request parameters and try again. If the problem persists, reconnect your Zendesk account in your MCP host app settings.'
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return response.json() as Promise<T>;
  }

  // This should never be reached, but TypeScript needs it
  throw new ZendeskError(
    'Rate limited. Maximum retries exhausted.',
    'RATE_LIMITED',
    'Zendesk API is rate limiting requests. Try again later.'
  );
}

class ZendeskError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string
  ) {
    super(message);
    this.name = 'ZendeskError';
  }
}

// Response formatting
interface FormatOptions {
  format?: 'concise' | 'detailed';
}

function formatTicket(ticket: ZendeskTicket, options: FormatOptions = {}): string {
  const format = options.format || 'concise';
  
  if (format === 'concise') {
    return `#${ticket.id}: ${ticket.subject} [${ticket.status}] (${ticket.priority || 'no priority'})`;
  }
  
  return [
    `Ticket #${ticket.id}`,
    `Subject: ${ticket.subject}`,
    `Status: ${ticket.status}`,
    `Priority: ${ticket.priority || 'none'}`,
    `Type: ${ticket.type || 'none'}`,
    `Requester ID: ${ticket.requester_id}`,
    `Assignee ID: ${ticket.assignee_id || 'unassigned'}`,
    `Group ID: ${ticket.group_id || 'none'}`,
    `Created: ${ticket.created_at}`,
    `Updated: ${ticket.updated_at}`,
    ticket.description ? `Description:\n${ticket.description}` : '',
  ].filter(Boolean).join('\n');
}

function formatUser(user: ZendeskUser, options: FormatOptions = {}): string {
  const format = options.format || 'concise';
  
  if (format === 'concise') {
    return `${user.name} <${user.email}> (ID: ${user.id}, ${user.role})`;
  }
  
  return [
    `User ID: ${user.id}`,
    `Name: ${user.name}`,
    `Email: ${user.email}`,
    `Role: ${user.role}`,
    `Active: ${user.active}`,
    `Created: ${user.created_at}`,
    user.phone ? `Phone: ${user.phone}` : '',
    user.organization_id ? `Organization ID: ${user.organization_id}` : '',
  ].filter(Boolean).join('\n');
}

function formatGroup(group: ZendeskGroup): string {
  return `${group.name} (ID: ${group.id})`;
}

function formatTicketField(field: ZendeskTicketField): string {
  const required = field.required ? ' [required]' : '';
  return `${field.title} (ID: ${field.id}, type: ${field.type})${required}`;
}

function formatMacro(macro: ZendeskMacro, options: FormatOptions = {}): string {
  const format = options.format || 'concise';
  const status = macro.active ? 'active' : 'inactive';

  if (format === 'concise') {
    const actionSummary = macro.actions.map(a => `${a.field}:${typeof a.value === 'string' ? a.value : JSON.stringify(a.value)}`).join(', ');
    return `${macro.title} (ID: ${macro.id}, ${status}) — actions: ${actionSummary}`;
  }

  return [
    `Macro #${macro.id}`,
    `Title: ${macro.title}`,
    macro.description ? `Description: ${macro.description}` : '',
    `Active: ${macro.active}`,
    `Actions:`,
    ...macro.actions.map(a => `  - ${a.field}: ${JSON.stringify(a.value)}`),
    macro.restriction ? `Restriction: ${macro.restriction.type}${macro.restriction.id ? ` (ID: ${macro.restriction.id})` : ''}` : '',
    `Created: ${macro.created_at}`,
    `Updated: ${macro.updated_at}`,
  ].filter(Boolean).join('\n');
}

// Zendesk types
interface ZendeskTicket {
  id: number;
  subject: string;
  description?: string;
  status: 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  type?: 'problem' | 'incident' | 'question' | 'task';
  requester_id: number;
  assignee_id?: number;
  group_id?: number;
  created_at: string;
  updated_at: string;
  tags?: string[];
  custom_fields?: Array<{ id: number; value: unknown }>;
}

interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  created_at: string;
  phone?: string;
  organization_id?: number;
}

interface ZendeskGroup {
  id: number;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

interface ZendeskTicketField {
  id: number;
  type: string;
  title: string;
  description?: string;
  required: boolean;
  active: boolean;
  position: number;
  custom_field_options?: Array<{ name: string; value: string }>;
}

interface ZendeskComment {
  id: number;
  body: string;
  author_id: number;
  created_at: string;
  public: boolean;
}

interface ZendeskView {
  id: number;
  title: string;
  active: boolean;
  position: number;
  restriction?: {
    type: string;
    id?: number;
  };
}

interface ZendeskOrganization {
  id: number;
  name: string;
  domain_names?: string[];
  created_at: string;
  updated_at: string;
  details?: string;
  notes?: string;
}

interface ZendeskMacro {
  id: number;
  title: string;
  description: string | null;
  active: boolean;
  actions: Array<{ field: string; value: string | string[] | null }>;
  restriction?: {
    type: string;
    id?: number;
  } | null;
  created_at: string;
  updated_at: string;
}

interface ZendeskMacroApplyResult {
  result: {
    ticket: Record<string, unknown>;
  };
}

// Guardrail constants
const MAX_TICKETS_WITH_COMMENTS = 200;
const MAX_IDS_IN_CONTEXT = 100;
const MAX_COMMENTS_PER_TICKET = 500;
const MAX_COMMENTS_PER_TICKET_BULK = 100;

// Tool definitions
const tools: Tool[] = [
  // Account management (OAuth is handled by the app, not MCP)
  {
    name: 'list_zendesk_accounts',
    description: `List connected Zendesk accounts with authentication status.

Returns all authenticated Zendesk subdomains with their associated email addresses, auth type, and status.
Auth types: "api-token" (recommended) or "oauth".
Status can be: "active", "needs-refresh", or "expired". API token accounts are always "active".

Use this to see which accounts are available before calling other Zendesk tools.
To connect a new account, use authenticate_zendesk_account or configure credentials via environment variables.`,
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'remove_zendesk_account',
    description: `Disconnect a Zendesk account.

Removes the stored credentials for the specified subdomain.
Use list_zendesk_accounts to see available subdomains.`,
    inputSchema: {
      type: 'object',
      properties: {
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain to disconnect',
        },
      },
      required: ['subdomain'],
    },
  },
  {
    name: 'authenticate_zendesk_account',
    description: `Connect a Zendesk account using API token authentication.

Requires:
- subdomain: Your Zendesk subdomain (e.g., "acme" for acme.zendesk.com)
- email: Your Zendesk agent email address
- api_token: API token from Zendesk Admin > Apps > APIs > Zendesk API

Get your API token:
1. Go to Zendesk Admin Center
2. Apps and Integrations > APIs > Zendesk API
3. Enable Token Access
4. Click "Add API token"
5. Copy the token`,
    inputSchema: {
      type: 'object',
      properties: {
        subdomain: { type: 'string', description: 'Zendesk subdomain (e.g., "acme" for acme.zendesk.com)' },
        email: { type: 'string', description: 'Zendesk agent email address' },
        api_token: { type: 'string', description: 'Zendesk API token' },
      },
      required: ['subdomain', 'email', 'api_token'],
    },
  },

  // Discovery tools
  {
    name: 'list_zendesk_groups',
    description: `List all agent groups in Zendesk.

Returns groups with their IDs and names. Use group IDs when:
- Creating tickets with a specific group assignment
- Updating ticket group_id
- Filtering tickets by group

Example: "Engineering Support" → ID: 360001234567`,
    inputSchema: {
      type: 'object',
      properties: {
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format: "concise" (default) for names+IDs, "detailed" for full metadata',
        },
      },
    },
  },
  {
    name: 'list_zendesk_ticket_fields',
    description: `List all ticket fields including custom fields.

Returns field IDs, titles, types, and options. Essential for:
- Finding custom field IDs for create/update operations
- Discovering dropdown options for custom fields
- Understanding required fields

Custom fields use numeric IDs (e.g., 360001234567) not names.`,
    inputSchema: {
      type: 'object',
      properties: {
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        active_only: {
          type: 'boolean',
          description: 'Only return active fields (default: true)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format: "concise" (default) for title+ID+type, "detailed" for full metadata including options',
        },
      },
    },
  },

  // Ticket operations
  {
    name: 'search_zendesk_tickets',
    description: `Search Zendesk tickets using Zendesk query syntax.

Query examples:
- "status:open" - Open tickets
- "status:open assignee:me" - My open tickets
- "priority:high status<solved" - High priority unsolved
- "created>2024-01-01 type:incident" - Incidents since Jan 1
- "tags:urgent" - Tickets with 'urgent' tag
- "requester:customer@example.com" - Tickets from specific requester

Common operators: status, priority, type, assignee, requester, group, tags, created, updated

Pagination: By default returns up to 100 results per page. If there are more results, use the page parameter to fetch subsequent pages, or set auto_paginate to true to fetch ALL pages automatically (up to 1000 results). The response always shows total count so you know if there are more.

Note: Zendesk search has a 1000 result limit. Use date filters to narrow large result sets.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Zendesk search query (e.g., "status:open priority:high")',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        sort_by: {
          type: 'string',
          enum: ['created_at', 'updated_at', 'priority', 'status'],
          description: 'Sort results by field (default: updated_at)',
        },
        sort_order: {
          type: 'string',
          enum: ['asc', 'desc'],
          description: 'Sort order (default: desc)',
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
        },
        per_page: {
          type: 'number',
          description: 'Results per page, max 100 (default: 100)',
        },
        auto_paginate: {
          type: 'boolean',
          description: 'Automatically fetch all pages of results up to 1000 total (default: false)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format: "concise" (default) for summary, "detailed" for full ticket data',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'export_zendesk_tickets',
    description: `Export Zendesk tickets using cursor-based pagination with NO 1000-result limit.

Use this instead of search_zendesk_tickets when you need MORE than 1000 results, such as bulk exports or comprehensive data analysis.

Uses the Zendesk Search Export API (/search/export.json) which supports unlimited results via cursor-based pagination. Auto-paginates through all matching results.

For bulk analysis (>100 tickets), use save_to_file=true to write results to a JSON file instead of returning them in the conversation. This avoids context overflow and enables processing thousands of tickets via scripts (grep, jq, Node.js).

IMPORTANT: Exports with more than 500 results REQUIRE save_to_file=true. The tool will reject large in-context exports to prevent context overflow.

Key differences from search_zendesk_tickets:
- No 1000-result ceiling (search_zendesk_tickets is capped at 1000)
- Always auto-paginates (no manual page parameter)
- Results are always sorted by created_at (no custom sort options)
- Slightly higher latency per page due to cursor overhead
- Has a safety cap (max_results, default 10000) to prevent runaway pagination

Query syntax is the same as search_zendesk_tickets (e.g., "status:open priority:high").

If rate limited or the cursor expires mid-pagination, returns partial results collected so far with a truncation warning.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Zendesk search query (e.g., "status:open priority:high")',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        page_size: {
          type: 'number',
          description: 'Results per cursor page, max 100 (default: 100)',
        },
        max_results: {
          type: 'number',
          description: 'Maximum total results to fetch (default: 10000). Safety cap to prevent runaway pagination.',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format: "concise" (default) for summary, "detailed" for full ticket data',
        },
        save_to_file: {
          type: 'boolean',
          description: 'Write results to a JSON file instead of returning in context. Recommended for bulk analysis (>100 tickets). Returns a summary with file path instead of ticket data.',
        },
        output_path: {
          type: 'string',
          description: 'Custom file path for export (only used when save_to_file is true). Default: <temp-dir>/zendesk-export-<timestamp>.json',
        },
        include_comments: {
          type: 'boolean',
          description: 'Fetch and include comments for each exported ticket (default: false). WARNING: Makes 1 additional API call per ticket. For 1,000 tickets this adds ~2.5 minutes; for 8,000 tickets ~20+ minutes. Only use for small exports or when comments are essential.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_zendesk_ticket',
    description: `Get a single ticket by ID with optional comments.

Returns ticket details including subject, description, status, priority, and metadata.
Use include_comments to also fetch the conversation thread.`,
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: {
          type: 'number',
          description: 'Ticket ID',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        include_comments: {
          type: 'boolean',
          description: 'Include ticket comments/conversation (default: false)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: detailed for single ticket)',
        },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'get_zendesk_tickets_by_ids',
    description: `Batch-fetch multiple Zendesk tickets by their IDs.

Fetches up to thousands of tickets in a single call using the Zendesk Show Many API.
Automatically batches requests when more than 100 IDs are provided (API limit is 100 per request).

Returns all found tickets plus a list of any IDs that were not found.
Duplicate and invalid (non-positive) IDs are automatically filtered out.

Use include_comments to also fetch comments for each ticket. WARNING: This makes one additional API request per ticket, so avoid using it with large sets (>50 tickets) to prevent rate limiting.

Example: Get tickets 101, 102, 103 with their comments:
{ "ids": [101, 102, 103], "include_comments": true }`,
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'number' },
          description: 'Array of ticket IDs to fetch',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        include_comments: {
          type: 'boolean',
          description: 'Fetch comments for each ticket (default: false). WARNING: Makes one API call per ticket — avoid for large sets (>50 tickets)',
        },
        save_to_file: {
          type: 'boolean',
          description: 'Write results to a JSON file instead of returning in context. Required when fetching more than 100 tickets. Returns a summary with file path instead of ticket data.',
        },
        output_path: {
          type: 'string',
          description: 'Custom file path for output (only used when save_to_file is true). Default: <temp-dir>/zendesk-tickets-by-ids-<timestamp>.json',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format: "concise" (default) for summary, "detailed" for full ticket data with request metadata',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'create_zendesk_ticket',
    description: `Create a new Zendesk ticket.

Required: subject and either comment (for new ticket with initial message) or description.
Optional: priority, type, tags, assignee_id, group_id, custom_fields.

For custom_fields, use list_zendesk_ticket_fields to find field IDs first.
For group_id, use list_zendesk_groups to find available groups.

Example:
{
  "subject": "Login issue",
  "comment": "User cannot log in after password reset",
  "priority": "high",
  "type": "incident"
}`,
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'Ticket subject line',
        },
        comment: {
          type: 'string',
          description: 'Initial ticket comment/description (visible to requester)',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        requester_email: {
          type: 'string',
          description: 'Requester email (creates user if needed)',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Ticket priority',
        },
        type: {
          type: 'string',
          enum: ['problem', 'incident', 'question', 'task'],
          description: 'Ticket type',
        },
        status: {
          type: 'string',
          enum: ['new', 'open', 'pending', 'hold', 'solved'],
          description: 'Initial status (default: new)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply',
        },
        assignee_id: {
          type: 'number',
          description: 'Agent ID to assign ticket to',
        },
        group_id: {
          type: 'number',
          description: 'Group ID (use list_zendesk_groups to find)',
        },
        custom_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              value: {},
            },
          },
          description: 'Custom field values (use list_zendesk_ticket_fields for IDs)',
        },
      },
      required: ['subject', 'comment'],
    },
  },
  {
    name: 'update_zendesk_ticket',
    description: `Update an existing Zendesk ticket.

Can update status, priority, assignee, tags, custom fields, and add comments.
Use add_comment to add a reply (public or internal note).

Example - resolve with comment:
{
  "ticket_id": 12345,
  "status": "solved",
  "add_comment": "Issue resolved - password reset successful",
  "comment_public": true
}`,
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: {
          type: 'number',
          description: 'Ticket ID to update',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        subject: {
          type: 'string',
          description: 'New subject line',
        },
        status: {
          type: 'string',
          enum: ['new', 'open', 'pending', 'hold', 'solved'],
          description: 'New status',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'New priority',
        },
        type: {
          type: 'string',
          enum: ['problem', 'incident', 'question', 'task'],
          description: 'New ticket type',
        },
        assignee_id: {
          type: 'number',
          description: 'New assignee ID',
        },
        group_id: {
          type: 'number',
          description: 'New group ID',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Replace all tags with this list',
        },
        add_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Add tags (keeps existing)',
        },
        remove_tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Remove specific tags',
        },
        add_comment: {
          type: 'string',
          description: 'Comment to add to ticket',
        },
        comment_public: {
          type: 'boolean',
          description: 'Is comment public (true) or internal note (false)? Default: true',
        },
        custom_fields: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              value: {},
            },
          },
          description: 'Custom field updates',
        },
      },
      required: ['ticket_id'],
    },
  },

  // User operations
  {
    name: 'search_zendesk_users',
    description: `Search Zendesk users by name, email, or query.

Examples:
- "john@example.com" - Find by email
- "John Smith" - Find by name
- "role:admin" - Find all admins
- "organization:Acme Corp" - Find by organization

Returns user ID, name, email, role, and organization.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query (name, email, or Zendesk query syntax)',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        role: {
          type: 'string',
          enum: ['end-user', 'agent', 'admin'],
          description: 'Filter by role',
        },
        page: {
          type: 'number',
          description: 'Page number (default: 1)',
        },
        per_page: {
          type: 'number',
          description: 'Results per page, max 100 (default: 25)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: concise)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_zendesk_user',
    description: `Get a Zendesk user by ID.

Returns full user details including name, email, role, phone, organization, and custom fields.`,
    inputSchema: {
      type: 'object',
      properties: {
        user_id: {
          type: 'number',
          description: 'User ID',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: detailed)',
        },
      },
      required: ['user_id'],
    },
  },

  // Comment operations
  {
    name: 'list_zendesk_ticket_comments',
    description: `List all comments/replies on a ticket.

Returns the conversation thread including public replies and internal notes.
Includes author ID, timestamp, and whether comment is public.
Automatically paginates to fetch all comments (Zendesk returns max 100 per page).`,
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: {
          type: 'number',
          description: 'Ticket ID',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        max_comments: {
          type: 'number',
          description: 'Maximum number of comments to fetch (default: 500). Use to limit results for very long threads.',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: concise)',
        },
      },
      required: ['ticket_id'],
    },
  },
  {
    name: 'add_zendesk_ticket_comment',
    description: `Add a comment to a ticket.

Can be a public reply (visible to requester) or internal note (agents only).
Default is public comment.`,
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: {
          type: 'number',
          description: 'Ticket ID',
        },
        body: {
          type: 'string',
          description: 'Comment text',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        public: {
          type: 'boolean',
          description: 'Public reply (true) or internal note (false)? Default: true',
        },
      },
      required: ['ticket_id', 'body'],
    },
  },

  // Views and Organizations
  {
    name: 'list_zendesk_views',
    description: `List available ticket views in Zendesk.

Views are saved searches/filters that organize tickets. Returns:
- View ID, title, and active status
- Whether the view is shared or personal

Use views to efficiently find tickets by pre-defined criteria like
"My open tickets", "Unassigned tickets", "High priority queue".`,
    inputSchema: {
      type: 'object',
      properties: {
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        active_only: {
          type: 'boolean',
          description: 'Only return active views (default: true)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: concise)',
        },
      },
    },
  },
  {
    name: 'list_zendesk_organizations',
    description: `List organizations in Zendesk.

Organizations group end-users (customers) together, typically by company.
Returns organization ID, name, and domain names.

Use organization IDs when:
- Filtering tickets by organization
- Creating users with an organization
- Understanding customer context`,
    inputSchema: {
      type: 'object',
      properties: {
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        page: {
          type: 'number',
          description: 'Page number (default: 1)',
        },
        per_page: {
          type: 'number',
          description: 'Results per page, max 100 (default: 25)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: concise)',
        },
      },
    },
  },

  // Macro operations
  {
    name: 'list_zendesk_macros',
    description: `List or search Zendesk macros.

Macros are predefined sets of actions that agents can apply to tickets with one click.
Actions can set ticket fields (status, priority, assignee, group), add comments, or modify tags.

When query is provided, searches macros by title. Otherwise lists all macros.
Use get_zendesk_macro to see the full actions for a specific macro.
Use apply_zendesk_macro to apply a macro to a ticket.`,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to filter macros by title (uses /macros/search endpoint). Omit to list all macros.',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        active: {
          type: 'boolean',
          description: 'Filter by active macros (default: all)',
        },
        page: {
          type: 'number',
          description: 'Page number (default: 1)',
        },
        per_page: {
          type: 'number',
          description: 'Results per page, max 100 (default: 100)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format: "concise" (default) for title+ID, "detailed" for full macro data including actions',
        },
      },
    },
  },
  {
    name: 'get_zendesk_macro',
    description: `Get a single Zendesk macro by ID.

Returns macro details including title, description, and the list of actions it performs.
Actions use { field, value } format where field is e.g. "status", "priority", "assignee_id",
"group_id", "comment_value", "current_tags", etc.

Use list_zendesk_macros to find macro IDs.`,
    inputSchema: {
      type: 'object',
      properties: {
        macro_id: {
          type: 'number',
          description: 'Macro ID',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        response_format: {
          type: 'string',
          enum: ['concise', 'detailed'],
          description: 'Response format (default: detailed)',
        },
      },
      required: ['macro_id'],
    },
  },
  {
    name: 'apply_zendesk_macro',
    description: `Preview and apply a Zendesk macro to a ticket.

First previews what changes the macro would make, then applies them.
Set preview_only=true to see the changes without applying.
This tool makes 2 API calls: one to preview, one to apply.

The preview shows the resulting ticket state after macro application.
When applied, the macro's actions (set status, add comment, change assignee, etc.) are executed on the ticket.

Example:
{
  "ticket_id": 12345,
  "macro_id": 67890
}`,
    inputSchema: {
      type: 'object',
      properties: {
        ticket_id: {
          type: 'number',
          description: 'Ticket ID to apply the macro to',
        },
        macro_id: {
          type: 'number',
          description: 'Macro ID to apply',
        },
        subdomain: {
          type: 'string',
          description: 'Zendesk subdomain (optional if only one account connected)',
        },
        preview_only: {
          type: 'boolean',
          description: 'If true, only preview the changes without applying (default: false)',
        },
      },
      required: ['ticket_id', 'macro_id'],
    },
  },
];

// File export helpers
async function writeToStream(stream: fs.WriteStream, data: string): Promise<void> {
  if (!stream.write(data)) {
    await new Promise<void>((resolve, reject) => {
      stream.once('drain', resolve);
      stream.once('error', reject);
    });
  }
}

async function finishStream(stream: fs.WriteStream): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    stream.once('error', reject);
    stream.end(() => resolve());
  });
}

/**
 * Fetch all comments for a ticket with pagination support.
 * Zendesk comments API returns max 100 per page by default.
 */
async function fetchAllTicketComments(
  account: ZendeskAccount,
  ticketId: number,
  options?: { maxComments?: number }
): Promise<{ comments: ZendeskComment[]; truncated: boolean }> {
  const maxComments = options?.maxComments ?? MAX_COMMENTS_PER_TICKET;
  const allComments: ZendeskComment[] = [];
  let page = 1;
  let hasMorePages = true;

  while (allComments.length < maxComments && hasMorePages) {
    const response = await zendeskFetch<{
      comments: ZendeskComment[];
      next_page: string | null;
      count: number;
    }>(account, `/tickets/${ticketId}/comments.json`, {
      params: { page: String(page), per_page: '100' },
    });

    allComments.push(...response.comments);
    hasMorePages = !!response.next_page;
    page++;
  }

  // Truncation: we collected more than maxComments, or stopped at the limit with more available
  const overLimit = allComments.length > maxComments;
  const atLimitWithMore = allComments.length >= maxComments && hasMorePages;
  const truncated = overLimit || atLimitWithMore;
  return {
    comments: allComments.length > maxComments ? allComments.slice(0, maxComments) : allComments,
    truncated,
  };
}

// Tool handler
async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  try {
    switch (name) {
      // Account management
      case 'list_zendesk_accounts': {
        // Hot-reload accounts
        loadAccounts();
        
        if (accounts.size === 0) {
          return JSON.stringify({
            ok: true,
            accounts: [],
            message: 'No Zendesk accounts connected. Use authenticate_zendesk_account or configure credentials via environment variables.',
          });
        }
        
        const accountList = Array.from(accounts.values()).map(account => ({
          subdomain: account.subdomain,
          email: account.email || 'unknown',
          authType: account.authType,
          status: getTokenStatus(account),
          ...(account.authType === 'oauth' ? { expiresAt: new Date(account.expiresAt).toISOString() } : {}),
        }));
        
        return JSON.stringify({
          ok: true,
          accounts: accountList,
          defaultSubdomain: accountsConfig.defaultSubdomain,
        });
      }

      case 'remove_zendesk_account': {
        const { subdomain } = args as { subdomain: string };
        
        // Remove from accounts.json
        const idx = accountsConfig.accounts.findIndex(a => a.subdomain === subdomain);
        if (idx >= 0) {
          accountsConfig.accounts.splice(idx, 1);
        }
        
        // Update default if needed
        if (accountsConfig.defaultSubdomain === subdomain) {
          accountsConfig.defaultSubdomain = accountsConfig.accounts[0]?.subdomain;
        }
        
        // Save accounts.json with restrictive permissions (contains API tokens)
        try {
          const accountsPath = path.join(CONFIG_PATH, 'accounts.json');
          fs.writeFileSync(accountsPath, JSON.stringify(accountsConfig, null, 2), { mode: 0o600 });
        } catch (error) {
          console.error('[Zendesk] Failed to save accounts:', error);
        }
        
        // Remove token file
        const tokenPath = path.join(CONFIG_PATH, 'credentials', `${subdomain}.token.json`);
        try {
          if (fs.existsSync(tokenPath)) {
            fs.unlinkSync(tokenPath);
          }
        } catch (error) {
          console.error(`[Zendesk] Failed to remove token file for ${subdomain}:`, error);
        }
        
        // Remove from memory
        accounts.delete(subdomain);

        return JSON.stringify({
          ok: true,
          message: `Disconnected ${subdomain}.zendesk.com`,
        });
      }

      case 'authenticate_zendesk_account': {
        const { subdomain, email, api_token } = args as { subdomain: string; email: string; api_token: string };
        if (!subdomain || !email || !api_token) {
          return JSON.stringify({ ok: false, error: 'subdomain, email, and api_token are all required.' });
        }
        try {
          const normalizedSubdomain = subdomain.trim();
          assertValidSubdomain(normalizedSubdomain);
          const result = await bridgeRequest('/bundled/zendesk/configure', {
            subdomain: normalizedSubdomain,
            email: email.trim(),
            apiToken: api_token.trim(),
          });
          if (result.success) {
            // Reload accounts to pick up the new credentials
            loadAccounts();
            return JSON.stringify({
              ok: true,
              message: `Zendesk account connected: ${normalizedSubdomain}.zendesk.com (${email})`,
              subdomain: normalizedSubdomain,
              email,
            });
          }
          return JSON.stringify({ ok: false, error: result.error || 'Failed to configure Zendesk account.' });
        } catch (error) {
          return JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : 'Failed to configure Zendesk account.',
            resolution: 'Check your subdomain, email, and API token. Make sure Token Access is enabled in Zendesk Admin.',
          });
        }
      }

      // Discovery tools
      case 'list_zendesk_groups': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const response = await zendeskFetch<{ groups: ZendeskGroup[] }>(
          account,
          '/groups.json'
        );

        const format = (args.response_format as string) || 'concise';
        if (format === 'concise') {
          const lines = response.groups.map(formatGroup);
          return `Groups (${response.groups.length}):\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          groups: response.groups,
          count: response.groups.length,
        });
      }

      case 'list_zendesk_ticket_fields': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const response = await zendeskFetch<{ ticket_fields: ZendeskTicketField[] }>(
          account,
          '/ticket_fields.json'
        );

        let fields = response.ticket_fields;
        const activeOnly = args.active_only !== false;
        if (activeOnly) {
          fields = fields.filter(f => f.active);
        }

        const format = (args.response_format as string) || 'concise';
        if (format === 'concise') {
          const lines = fields.map(formatTicketField);
          return `Ticket Fields (${fields.length}):\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          ticket_fields: fields,
          count: fields.length,
        });
      }

      // Ticket operations
      case 'search_zendesk_tickets': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const query = args.query as string;
        if (!query) {
          return JSON.stringify({
            ok: false,
            error: 'Query is required',
            resolution: 'Provide a search query like "status:open" or "priority:high"',
          });
        }

        // Zendesk search endpoint
        const perPage = Math.min((args.per_page as number) || 100, 100);
        const autoPaginate = args.auto_paginate === true;
        const startPage = (args.page as number) || 1;

        const params: Record<string, string | number> = {
          query: `type:ticket ${query}`,
          sort_by: (args.sort_by as string) || 'updated_at',
          sort_order: (args.sort_order as string) || 'desc',
          page: startPage,
          per_page: perPage,
        };

        const firstResponse = await zendeskFetch<{
          results: ZendeskTicket[];
          count: number;
          next_page?: string;
          previous_page?: string;
        }>(account, '/search.json', { params });

        let allResults = firstResponse.results;
        let totalCount = firstResponse.count;

        // Auto-paginate: fetch remaining pages up to 1000 results total
        if (autoPaginate && firstResponse.next_page) {
          const maxResults = 1000;
          let currentPage = startPage + 1;
          while (allResults.length < totalCount && allResults.length < maxResults) {
            const nextResponse = await zendeskFetch<{
              results: ZendeskTicket[];
              count: number;
              next_page?: string;
            }>(account, '/search.json', { params: { ...params, page: currentPage } });

            if (nextResponse.results.length === 0) break;
            allResults = allResults.concat(nextResponse.results);
            if (!nextResponse.next_page) break;
            currentPage++;
          }
        }

        const format = (args.response_format as string) || 'concise';
        const formatOpts = { format: format as 'concise' | 'detailed' };
        const hasMore = !autoPaginate && totalCount > startPage * perPage;
        const truncated = autoPaginate && (allResults.length >= 1000 || totalCount > allResults.length);
        const truncationReason = truncated
          ? `Auto-pagination capped at ${allResults.length} of ${totalCount} results (Zendesk search limit: 1000)`
          : undefined;

        if (format === 'concise') {
          const lines = allResults.map(t => formatTicket(t, formatOpts));
          let output = '';
          if (truncated) {
            output += `WARNING: Results truncated — showing ${allResults.length} of ${totalCount} (Zendesk search API limit: 1000)\n`;
          }
          output += `Search results (${allResults.length} of ${totalCount})${hasMore ? ' - more available' : ''}:\n\n${lines.join('\n')}`;
          return output;
        }

        return JSON.stringify({
          ok: true,
          tickets: allResults,
          count: allResults.length,
          total: totalCount,
          hasMore,
          truncated,
          ...(truncationReason ? { truncation_reason: truncationReason } : {}),
        });
      }

      case 'export_zendesk_tickets': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const query = args.query as string;
        if (!query) {
          return JSON.stringify({
            ok: false,
            error: 'Query is required',
            resolution: 'Provide a search query like "status:open" or "priority:high"',
          });
        }

        const pageSize = Math.min((args.page_size as number) || 100, 100);
        const maxResults = (args.max_results as number) || 10000;
        const saveToFile = args.save_to_file === true;
        const includeComments = args.include_comments === true;
        const outputPath = saveToFile
          ? resolveTempOutputPath((args.output_path as string) || path.join(os.tmpdir(), `zendesk-export-${Date.now()}.json`))
          : '';

        // Guardrail: reject include_comments for large exports
        if (includeComments && maxResults > MAX_TICKETS_WITH_COMMENTS) {
          return JSON.stringify({
            ok: false,
            error: `include_comments is not supported for exports with more than ${MAX_TICKETS_WITH_COMMENTS} tickets (max_results=${maxResults}).`,
            suggestion: `Set max_results to ${MAX_TICKETS_WITH_COMMENTS} or lower to enable comment fetching, or export without include_comments first.`,
          });
        }

        // Export search uses filter[type] and page[size] bracket-syntax params
        const params: Record<string, string | number> = {
          query,
          'filter[type]': 'ticket',
          'page[size]': pageSize,
        };

        if (saveToFile) {
          // ── File export path: stream results to disk page-by-page ──
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          const writeStream = fs.createWriteStream(outputPath, { mode: 0o600 });
          let streamError: Error | null = null;
          writeStream.on('error', (err) => { streamError = err; });

          // SIGTERM handler for best-effort JSON closure on process termination
          let sigTermHandler: (() => void) | null = null;
          sigTermHandler = () => {
            try { writeStream.write('\n]'); writeStream.end(); } catch { /* best effort */ }
          };
          process.on('SIGTERM', sigTermHandler);
          process.on('SIGINT', sigTermHandler);

          let totalCount = 0;
          let isFirstTicket = true;
          let truncated = false;
          let truncationReason: string | undefined;
          const statusCounts: Record<string, number> = {};
          let earliest = '';
          let latest = '';
          let commentErrors = 0;

          try {
            await writeToStream(writeStream, '[\n');

            // First page
            const firstResponse = await zendeskFetch<{
              results: ZendeskTicket[];
              meta: { has_more: boolean; after_cursor: string };
              links: { next: string };
            }>(account, '/search/export.json', { params });

            let meta = firstResponse.meta;
            let currentResults = firstResponse.results;

            // Process pages
            let hasMorePages = true;
            while (hasMorePages) {
              if (streamError) throw streamError;

              for (const ticket of currentResults) {
                if (streamError) throw streamError;
                if (totalCount >= maxResults) {
                  truncated = true;
                  truncationReason = `Results capped at max_results limit (${maxResults})`;
                  break;
                }

                // Optionally fetch comments for this ticket
                let ticketToWrite: ZendeskTicket & { comments?: ZendeskComment[] } = ticket;
                if (includeComments) {
                  try {
                    const { comments } = await fetchAllTicketComments(account, ticket.id, { maxComments: MAX_COMMENTS_PER_TICKET_BULK });
                    ticketToWrite = { ...ticket, comments };
                  } catch {
                    commentErrors++;
                  }
                }

                // Write ticket to stream
                const prefix = isFirstTicket ? '' : ',\n';
                await writeToStream(writeStream, prefix + JSON.stringify(ticketToWrite));
                isFirstTicket = false;
                totalCount++;

                // Track stats
                statusCounts[ticket.status] = (statusCounts[ticket.status] || 0) + 1;
                if (!earliest || ticket.created_at < earliest) earliest = ticket.created_at;
                if (!latest || ticket.created_at > latest) latest = ticket.created_at;
              }

              // Check if we should continue
              if (truncated || !meta.has_more || totalCount >= maxResults) {
                hasMorePages = false;
              } else if (!meta.after_cursor) {
                truncated = true;
                truncationReason = 'Pagination stopped: cursor missing despite more results available';
                hasMorePages = false;
              } else {
                // Fetch next page
                const nextResponse = await zendeskFetch<{
                  results: ZendeskTicket[];
                  meta: { has_more: boolean; after_cursor: string };
                  links: { next: string };
                }>(account, '/search/export.json', {
                  params: { ...params, 'page[after]': meta.after_cursor },
                });

                if (nextResponse.results.length === 0) {
                  hasMorePages = false;
                } else {
                  currentResults = nextResponse.results;
                  meta = nextResponse.meta;
                }
              }
            }

            await writeToStream(writeStream, '\n]');
            await finishStream(writeStream);
          } catch (error) {
            // Best-effort: close JSON array and flush to disk (must await for Windows NTFS)
            try {
              writeStream.write('\n]');
              await finishStream(writeStream);
            } catch { /* best effort */ }

            if (totalCount > 0) {
              truncated = true;
              truncationReason = `Pagination interrupted: ${error instanceof Error ? error.message : String(error)}. ${totalCount} tickets written before error.`;
            } else {
              // Clean up and remove the SIGTERM handler before re-throwing
              if (sigTermHandler) process.removeListener('SIGTERM', sigTermHandler);
              if (sigTermHandler) process.removeListener('SIGINT', sigTermHandler);
              throw error;
            }
          } finally {
            if (sigTermHandler) process.removeListener('SIGTERM', sigTermHandler);
            if (sigTermHandler) process.removeListener('SIGINT', sigTermHandler);
          }

          const fileSizeKb = totalCount > 0 ? Math.round(fs.statSync(outputPath).size / 1024) : 0;

          return JSON.stringify({
            ok: true,
            exported: true,
            file_path: outputPath,
            count: totalCount,
            file_size_kb: fileSizeKb,
            date_range: { earliest, latest },
            status_breakdown: statusCounts,
            truncated,
            ...(truncationReason ? { truncation_reason: truncationReason } : {}),
            ...(commentErrors > 0 ? { comment_fetch_errors: commentErrors } : {}),
          });
        }

        // ── In-context export path (existing behavior) ──
        let allResults: ZendeskTicket[] = [];
        let truncated = false;
        let truncationReason: string | undefined;

        try {
          // First page
          const firstResponse = await zendeskFetch<{
            results: ZendeskTicket[];
            meta: { has_more: boolean; after_cursor: string };
            links: { next: string };
          }>(account, '/search/export.json', { params });

          allResults = firstResponse.results;

          // Auto-guardrail: reject large non-file exports
          if (firstResponse.meta.has_more && maxResults > 500) {
            return JSON.stringify({
              ok: false,
              error: 'Large result set detected. Use save_to_file=true for bulk exports to avoid overwhelming the conversation context.',
              estimated_results: '500+',
              suggestion: 'Re-run with save_to_file=true to write results to a file instead.',
            });
          }

          // Auto-paginate using cursor
          let meta = firstResponse.meta;
          while (meta.has_more && allResults.length < maxResults) {
            // Defensive: break if cursor is missing when has_more is true
            if (!meta.after_cursor) {
              truncated = true;
              truncationReason = 'Pagination stopped: cursor missing despite more results available';
              break;
            }

            const nextResponse = await zendeskFetch<{
              results: ZendeskTicket[];
              meta: { has_more: boolean; after_cursor: string };
              links: { next: string };
            }>(account, '/search/export.json', {
              params: { ...params, 'page[after]': meta.after_cursor },
            });

            if (nextResponse.results.length === 0) break;
            allResults = allResults.concat(nextResponse.results);
            meta = nextResponse.meta;
          }

          // Enforce max_results cap regardless of has_more
          if (allResults.length > maxResults) {
            allResults = allResults.slice(0, maxResults);
            truncated = true;
            truncationReason = `Results capped at max_results limit (${maxResults})`;
          }
        } catch (error) {
          // On rate limit or cursor expiry, return partial results
          if (allResults.length > 0) {
            truncated = true;
            truncationReason = `Pagination interrupted: ${error instanceof Error ? error.message : String(error)}. Returning ${allResults.length} results collected before the error.`;
          } else {
            // No results collected — re-throw to hit the outer error handler
            throw error;
          }
        }

        const format = (args.response_format as string) || 'concise';
        const formatOpts = { format: format as 'concise' | 'detailed' };

        if (format === 'concise') {
          const lines = allResults.map(t => formatTicket(t, formatOpts));
          let header = `Export results (${allResults.length} tickets)`;
          if (truncated) {
            header += ` [TRUNCATED: ${truncationReason}]`;
          }
          return `${header}:\n\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          tickets: allResults,
          count: allResults.length,
          truncated,
          ...(truncationReason ? { truncation_reason: truncationReason } : {}),
        });
      }

      case 'get_zendesk_ticket': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const ticketId = args.ticket_id as number;
        if (!ticketId) {
          return JSON.stringify({
            ok: false,
            error: 'ticket_id is required',
          });
        }

        const response = await zendeskFetch<{ ticket: ZendeskTicket }>(
          account,
          `/tickets/${ticketId}.json`
        );

        let comments: ZendeskComment[] | undefined;
        if (args.include_comments) {
          const { comments: fetchedComments } = await fetchAllTicketComments(account, ticketId);
          comments = fetchedComments;
        }

        const format = (args.response_format as string) || 'detailed';
        const formatOpts = { format: format as 'concise' | 'detailed' };

        if (format === 'concise') {
          let result = formatTicket(response.ticket, formatOpts);
          if (comments) {
            result += `\n\nComments (${comments.length}):\n`;
            result += comments
              .map(c => `[${c.created_at}] ${c.public ? 'Public' : 'Internal'}: ${c.body.slice(0, 200)}${c.body.length > 200 ? '...' : ''}`)
              .join('\n');
          }
          return result;
        }

        return JSON.stringify({
          ok: true,
          ticket: response.ticket,
          comments,
        });
      }

      case 'get_zendesk_tickets_by_ids': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const rawIds = args.ids as number[];
        if (!Array.isArray(rawIds) || rawIds.length === 0) {
          return JSON.stringify({
            ok: false,
            error: 'ids is required and must be a non-empty array of ticket IDs',
            resolution: 'Provide an array of numeric ticket IDs, e.g. { "ids": [101, 102, 103] }',
          });
        }

        // Deduplicate and filter non-positive IDs
        const ids = [...new Set(rawIds.filter(id => typeof id === 'number' && id > 0))];
        if (ids.length === 0) {
          return JSON.stringify({
            ok: false,
            error: 'No valid ticket IDs provided (IDs must be positive numbers)',
            resolution: 'Provide an array of positive numeric ticket IDs, e.g. { "ids": [101, 102, 103] }',
          });
        }

        const saveToFile = args.save_to_file === true;
        const outputPath = saveToFile
          ? resolveTempOutputPath((args.output_path as string) || path.join(os.tmpdir(), `zendesk-tickets-by-ids-${Date.now()}.json`))
          : '';

        // Guardrail: reject large in-context fetches
        if (ids.length > MAX_IDS_IN_CONTEXT && !saveToFile) {
          return JSON.stringify({
            ok: false,
            error: `Fetching ${ids.length} tickets in-context would produce a very large response.`,
            suggestion: `Use save_to_file=true to write results to a file, or reduce to ≤${MAX_IDS_IN_CONTEXT} IDs.`,
          });
        }

        // Split into chunks of 100 (API limit)
        const chunkSize = 100;
        const chunks: number[][] = [];
        for (let i = 0; i < ids.length; i += chunkSize) {
          chunks.push(ids.slice(i, i + chunkSize));
        }

        // Fetch tickets in sequential batches
        let allTickets: ZendeskTicket[] = [];
        for (const chunk of chunks) {
          const response = await zendeskFetch<{ tickets: ZendeskTicket[] }>(
            account,
            '/tickets/show_many.json',
            { params: { ids: chunk.join(',') } }
          );
          allTickets = allTickets.concat(response.tickets);
        }

        // Determine missing IDs
        const foundIds = new Set(allTickets.map(t => t.id));
        const missingIds = ids.filter(id => !foundIds.has(id));

        // Fetch comments if requested (resilient — individual failures don't abort the batch)
        let commentsMap: Record<number, ZendeskComment[]> | undefined;
        const commentErrors: number[] = [];
        if (args.include_comments) {
          commentsMap = {};
          for (const ticket of allTickets) {
            try {
              const { comments } = await fetchAllTicketComments(account, ticket.id, { maxComments: MAX_COMMENTS_PER_TICKET_BULK });
              commentsMap[ticket.id] = comments;
            } catch {
              commentErrors.push(ticket.id);
            }
          }
        }

        // File export path: write all tickets to disk
        if (saveToFile) {
          const dir = path.dirname(outputPath);
          fs.mkdirSync(dir, { recursive: true });

          // Build output data — embed comments into ticket objects if fetched
          const outputData = commentsMap
            ? allTickets.map(t => ({ ...t, comments: commentsMap![t.id] ?? [] }))
            : allTickets;

          fs.writeFileSync(outputPath, JSON.stringify(outputData, null, 2), { mode: 0o600 });
          const stats = fs.statSync(outputPath);

          return JSON.stringify({
            ok: true,
            exported: true,
            file_path: outputPath,
            count: allTickets.length,
            file_size_kb: Math.round(stats.size / 1024),
            missing_ids: missingIds,
            ...(commentErrors.length > 0 ? { comment_fetch_errors: commentErrors } : {}),
          });
        }

        const format = (args.response_format as string) || 'concise';
        const formatOpts = { format: format as 'concise' | 'detailed' };

        if (format === 'concise') {
          const lines = allTickets.map(t => {
            let line = formatTicket(t, formatOpts);
            if (commentsMap && commentsMap[t.id]) {
              const commentCount = commentsMap[t.id].length;
              line += ` (${commentCount} comment${commentCount !== 1 ? 's' : ''})`;
            }
            return line;
          });
          let result = `Tickets (${allTickets.length} of ${ids.length} requested):\n\n${lines.join('\n')}`;
          if (missingIds.length > 0) {
            result += `\n\nMissing IDs (${missingIds.length}): ${missingIds.join(', ')}`;
          }
          if (commentErrors.length > 0) {
            result += `\n\nFailed to fetch comments for tickets: ${commentErrors.join(', ')}`;
          }
          if (commentsMap) {
            result += '\n\n--- Comments ---';
            for (const ticket of allTickets) {
              const comments = commentsMap[ticket.id];
              if (comments && comments.length > 0) {
                result += `\n\nTicket #${ticket.id} comments (${comments.length}):`;
                result += '\n' + comments
                  .map(c => `[${c.created_at}] ${c.public ? 'Public' : 'Internal'}: ${c.body.slice(0, 200)}${c.body.length > 200 ? '...' : ''}`)
                  .join('\n');
              }
            }
          }
          return result;
        }

        return JSON.stringify({
          ok: true,
          tickets: allTickets,
          requested: ids.length,
          found: allTickets.length,
          missing_ids: missingIds,
          ...(commentsMap ? { comments: commentsMap } : {}),
          ...(commentErrors.length > 0 ? { comment_fetch_errors: commentErrors } : {}),
        });
      }

      case 'create_zendesk_ticket': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const subject = args.subject as string;
        const comment = args.comment as string;

        if (!subject || !comment) {
          return JSON.stringify({
            ok: false,
            error: 'subject and comment are required',
          });
        }

        interface TicketPayload {
          ticket: {
            subject: string;
            comment: { body: string };
            requester?: { email: string };
            priority?: string;
            type?: string;
            status?: string;
            tags?: string[];
            assignee_id?: number;
            group_id?: number;
            custom_fields?: Array<{ id: number; value: unknown }>;
          };
        }

        const payload: TicketPayload = {
          ticket: {
            subject,
            comment: { body: comment },
          },
        };

        if (args.requester_email) {
          payload.ticket.requester = { email: args.requester_email as string };
        }
        if (args.priority) payload.ticket.priority = args.priority as string;
        if (args.type) payload.ticket.type = args.type as string;
        if (args.status) payload.ticket.status = args.status as string;
        if (args.tags) payload.ticket.tags = args.tags as string[];
        if (args.assignee_id) payload.ticket.assignee_id = args.assignee_id as number;
        if (args.group_id) payload.ticket.group_id = args.group_id as number;
        if (args.custom_fields) {
          payload.ticket.custom_fields = args.custom_fields as Array<{ id: number; value: unknown }>;
        }

        const response = await zendeskFetch<{ ticket: ZendeskTicket }>(
          account,
          '/tickets.json',
          { method: 'POST', body: JSON.stringify(payload) }
        );

        return JSON.stringify({
          ok: true,
          message: `Created ticket #${response.ticket.id}`,
          ticket: {
            id: response.ticket.id,
            subject: response.ticket.subject,
            status: response.ticket.status,
            url: `https://${account.subdomain}.zendesk.com/agent/tickets/${response.ticket.id}`,
          },
        });
      }

      case 'update_zendesk_ticket': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const ticketId = args.ticket_id as number;
        if (!ticketId) {
          return JSON.stringify({
            ok: false,
            error: 'ticket_id is required',
          });
        }

        interface UpdatePayload {
          ticket: {
            subject?: string;
            status?: string;
            priority?: string;
            type?: string;
            assignee_id?: number;
            group_id?: number;
            tags?: string[];
            additional_tags?: string[];
            remove_tags?: string[];
            comment?: { body: string; public: boolean };
            custom_fields?: Array<{ id: number; value: unknown }>;
          };
        }

        const payload: UpdatePayload = { ticket: {} };

        if (args.subject) payload.ticket.subject = args.subject as string;
        if (args.status) payload.ticket.status = args.status as string;
        if (args.priority) payload.ticket.priority = args.priority as string;
        if (args.type) payload.ticket.type = args.type as string;
        if (args.assignee_id) payload.ticket.assignee_id = args.assignee_id as number;
        if (args.group_id) payload.ticket.group_id = args.group_id as number;
        if (args.tags) payload.ticket.tags = args.tags as string[];
        if (args.add_tags) payload.ticket.additional_tags = args.add_tags as string[];
        if (args.remove_tags) payload.ticket.remove_tags = args.remove_tags as string[];
        if (args.custom_fields) {
          payload.ticket.custom_fields = args.custom_fields as Array<{ id: number; value: unknown }>;
        }

        if (args.add_comment) {
          payload.ticket.comment = {
            body: args.add_comment as string,
            public: args.comment_public !== false,
          };
        }

        const response = await zendeskFetch<{ ticket: ZendeskTicket }>(
          account,
          `/tickets/${ticketId}.json`,
          { method: 'PUT', body: JSON.stringify(payload) }
        );

        return JSON.stringify({
          ok: true,
          message: `Updated ticket #${ticketId}`,
          ticket: {
            id: response.ticket.id,
            subject: response.ticket.subject,
            status: response.ticket.status,
            priority: response.ticket.priority,
          },
        });
      }

      // User operations
      case 'search_zendesk_users': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const query = args.query as string;
        if (!query) {
          return JSON.stringify({
            ok: false,
            error: 'Query is required',
          });
        }

        const params: Record<string, string | number> = {
          query: `type:user ${query}`,
          page: (args.page as number) || 1,
          per_page: Math.min((args.per_page as number) || 25, 100),
        };

        const response = await zendeskFetch<{
          results: ZendeskUser[];
          count: number;
          next_page?: string;
        }>(account, '/search.json', { params });

        const format = (args.response_format as string) || 'concise';
        const formatOpts = { format: format as 'concise' | 'detailed' };

        if (format === 'concise') {
          const lines = response.results.map(u => formatUser(u, formatOpts));
          return `Users (${response.results.length} of ${response.count}):\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          users: response.results,
          count: response.results.length,
          total: response.count,
        });
      }

      case 'get_zendesk_user': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const userId = args.user_id as number;
        if (!userId) {
          return JSON.stringify({
            ok: false,
            error: 'user_id is required',
          });
        }

        const response = await zendeskFetch<{ user: ZendeskUser }>(
          account,
          `/users/${userId}.json`
        );

        const format = (args.response_format as string) || 'detailed';
        if (format === 'concise') {
          return formatUser(response.user, { format: 'concise' });
        }

        return JSON.stringify({
          ok: true,
          user: response.user,
        });
      }

      // Comment operations
      case 'list_zendesk_ticket_comments': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const ticketId = args.ticket_id as number;
        if (!ticketId) {
          return JSON.stringify({
            ok: false,
            error: 'ticket_id is required',
          });
        }

        const maxComments = (args.max_comments as number) || undefined;
        const { comments: allComments, truncated: commentsTruncated } = await fetchAllTicketComments(
          account,
          ticketId,
          maxComments ? { maxComments } : undefined
        );

        // Resolve author IDs to names (batch fetch unique authors)
        // Filter to valid numeric IDs in case any are missing/null
        const authorIds = [...new Set(
          allComments
            .map(c => c.author_id)
            .filter((id): id is number => typeof id === 'number' && id > 0)
        )];
        const authorMap = new Map<number, string>();
        
        if (authorIds.length > 0) {
          try {
            // Zendesk supports fetching multiple users by ID
            const usersResponse = await zendeskFetch<{ users: ZendeskUser[] }>(
              account,
              `/users/show_many.json`,
              { params: { ids: authorIds.join(',') } }
            );
            for (const user of usersResponse.users) {
              authorMap.set(user.id, user.name);
            }
          } catch {
            // If batch fetch fails, continue with IDs only
          }
        }

        const format = (args.response_format as string) || 'concise';
        if (format === 'concise') {
          const lines = allComments.map(c => {
            const visibility = c.public ? 'Public' : 'Internal';
            const preview = c.body.slice(0, 150) + (c.body.length > 150 ? '...' : '');
            const authorName = authorMap.get(c.author_id) || `User ${c.author_id}`;
            return `[${c.created_at}] ${visibility} - ${authorName}:\n${preview}`;
          });
          let result = `Comments on ticket #${ticketId} (${allComments.length}):\n\n${lines.join('\n\n')}`;
          if (commentsTruncated) {
            result += `\n\n[TRUNCATED: More comments exist but were limited to ${maxComments ?? MAX_COMMENTS_PER_TICKET}]`;
          }
          return result;
        }

        // For detailed format, include author names in response
        const commentsWithAuthors = allComments.map(c => ({
          ...c,
          author_name: authorMap.get(c.author_id) || null,
        }));

        return JSON.stringify({
          ok: true,
          comments: commentsWithAuthors,
          count: allComments.length,
          truncated: commentsTruncated,
        });
      }

      case 'add_zendesk_ticket_comment': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const ticketId = args.ticket_id as number;
        const body = args.body as string;

        if (!ticketId || !body) {
          return JSON.stringify({
            ok: false,
            error: 'ticket_id and body are required',
          });
        }

        const payload = {
          ticket: {
            comment: {
              body,
              public: args.public !== false,
            },
          },
        };

        await zendeskFetch(
          account,
          `/tickets/${ticketId}.json`,
          { method: 'PUT', body: JSON.stringify(payload) }
        );

        const visibility = args.public !== false ? 'public comment' : 'internal note';
        return JSON.stringify({
          ok: true,
          message: `Added ${visibility} to ticket #${ticketId}`,
        });
      }

      // Views and Organizations
      case 'list_zendesk_views': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const response = await zendeskFetch<{ views: ZendeskView[] }>(
          account,
          '/views.json'
        );

        let views = response.views;
        const activeOnly = args.active_only !== false;
        if (activeOnly) {
          views = views.filter(v => v.active);
        }

        const format = (args.response_format as string) || 'concise';
        if (format === 'concise') {
          const lines = views.map(v => {
            // Zendesk restriction types: null=shared, 'User'=personal, 'Group'=group-restricted
            const visibility = !v.restriction ? 'Shared'
              : v.restriction.type === 'User' ? 'Personal'
              : v.restriction.type === 'Group' ? 'Group'
              : 'Restricted';
            return `${v.title} (ID: ${v.id}, ${visibility})`;
          });
          return `Views (${views.length}):\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          views,
          count: views.length,
        });
      }

      case 'list_zendesk_organizations': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) {
          return noAccountError();
        }

        const params: Record<string, string | number> = {
          page: (args.page as number) || 1,
          per_page: Math.min((args.per_page as number) || 25, 100),
        };

        const response = await zendeskFetch<{
          organizations: ZendeskOrganization[];
          count: number;
          next_page?: string;
        }>(account, '/organizations.json', { params });

        const format = (args.response_format as string) || 'concise';
        if (format === 'concise') {
          const lines = response.organizations.map(o => {
            const domains = o.domain_names?.length ? ` [${o.domain_names.join(', ')}]` : '';
            return `${o.name} (ID: ${o.id})${domains}`;
          });
          return `Organizations (${response.organizations.length} of ${response.count}):\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          organizations: response.organizations,
          count: response.organizations.length,
          total: response.count,
          hasMore: !!response.next_page,
        });
      }

      // Macro operations
      case 'list_zendesk_macros': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) return noAccountError();

        const query = args.query as string | undefined;
        const perPage = Math.min((args.per_page as number) || 100, 100);
        const page = (args.page as number) || 1;

        let macros: ZendeskMacro[];
        let totalCount: number;
        let hasMore: boolean;

        if (query) {
          // Search macros by title
          const response = await zendeskFetch<{
            results: ZendeskMacro[];
            count: number;
            next_page: string | null;
          }>(account, '/macros/search.json', {
            params: { query, page, per_page: perPage },
          });
          macros = response.results;
          totalCount = response.count;
          hasMore = !!response.next_page;
        } else {
          // List all macros
          const params: Record<string, string | number | boolean | undefined> = {
            page,
            per_page: perPage,
          };
          if (args.active !== undefined) {
            params.active = args.active as boolean;
          }
          const response = await zendeskFetch<{
            macros: ZendeskMacro[];
            count: number;
            next_page: string | null;
          }>(account, '/macros.json', { params });
          macros = response.macros;
          totalCount = response.count;
          hasMore = !!response.next_page;
        }

        const format = (args.response_format as string) || 'concise';
        const formatOpts = { format: format as 'concise' | 'detailed' };

        if (format === 'concise') {
          const lines = macros.map(m => formatMacro(m, formatOpts));
          return `Macros (${macros.length} of ${totalCount})${hasMore ? ' - more available' : ''}:\n${lines.join('\n')}`;
        }

        return JSON.stringify({
          ok: true,
          macros,
          count: macros.length,
          total: totalCount,
          hasMore,
        });
      }

      case 'get_zendesk_macro': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) return noAccountError();

        const macroId = args.macro_id as number;
        if (!macroId) {
          return JSON.stringify({
            ok: false,
            error: 'macro_id is required',
            resolution: 'Provide the numeric ID of the macro. Use list_zendesk_macros to find macro IDs.',
          });
        }

        const response = await zendeskFetch<{ macro: ZendeskMacro }>(
          account,
          `/macros/${macroId}.json`
        );

        const format = (args.response_format as string) || 'detailed';
        if (format === 'concise') {
          return formatMacro(response.macro, { format: 'concise' });
        }

        return JSON.stringify({
          ok: true,
          macro: response.macro,
        });
      }

      case 'apply_zendesk_macro': {
        const account = await getAccount(args.subdomain as string | undefined);
        if (!account) return noAccountError();

        const ticketId = args.ticket_id as number;
        const macroId = args.macro_id as number;

        if (!ticketId || !macroId) {
          return JSON.stringify({
            ok: false,
            error: 'ticket_id and macro_id are required',
            resolution: 'Provide both the ticket ID and the macro ID. Use list_zendesk_macros to find macro IDs.',
          });
        }

        // Step 1: Preview — get the changes the macro would make
        const preview = await zendeskFetch<ZendeskMacroApplyResult>(
          account,
          `/tickets/${ticketId}/macros/${macroId}/apply.json`
        );

        const previewTicket = preview.result.ticket;

        if (args.preview_only === true) {
          return JSON.stringify({
            ok: true,
            preview: true,
            message: `Preview of macro ${macroId} on ticket #${ticketId} (not applied)`,
            changes: previewTicket,
          });
        }

        // Step 2: Apply — strip read-only fields from preview, send the rest as PUT payload
        const readOnlyFields = new Set([
          'id', 'url', 'created_at', 'updated_at', 'requester_id', 'via',
          'satisfaction_rating', 'sharing_agreement_ids', 'followup_ids',
          'ticket_id', 'result_type',
        ]);

        const ticketUpdate: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(previewTicket)) {
          if (!readOnlyFields.has(key) && value !== undefined) {
            ticketUpdate[key] = value;
          }
        }

        // Strip preview-only metadata from comment object
        if (ticketUpdate.comment && typeof ticketUpdate.comment === 'object') {
          const { scoped_body, ...cleanComment } = ticketUpdate.comment as Record<string, unknown>;
          ticketUpdate.comment = cleanComment;
        }

        const updateResponse = await zendeskFetch<{ ticket: ZendeskTicket }>(
          account,
          `/tickets/${ticketId}.json`,
          { method: 'PUT', body: JSON.stringify({ ticket: ticketUpdate }) }
        );

        // Summarize what was applied
        const appliedFields = Object.keys(ticketUpdate);
        const hasComment = 'comment' in ticketUpdate;

        return JSON.stringify({
          ok: true,
          message: `Macro ${macroId} applied to ticket #${ticketId}`,
          applied_fields: appliedFields,
          comment_added: hasComment,
          ticket: {
            id: updateResponse.ticket.id,
            subject: updateResponse.ticket.subject,
            status: updateResponse.ticket.status,
            priority: updateResponse.ticket.priority,
          },
        });
      }

      default:
        return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    }
  } catch (error) {
    if (error instanceof ZendeskError) {
      return JSON.stringify({
        ok: false,
        error: error.message,
        code: error.code,
        resolution: error.resolution,
      });
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return JSON.stringify({ ok: false, error: errorMessage });
  }
}

function noAccountError(): string {
  return JSON.stringify({
    ok: false,
    error: 'No Zendesk account connected',
    resolution: 'Use authenticate_zendesk_account or configure credentials via environment variables.',
  });
}

// Create MCP server
const server = new Server(
  {
    name: 'zendesk-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleToolCall(name, (args as Record<string, unknown>) || {});
  return {
    content: [{ type: 'text', text: result }],
  };
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Zendesk MCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
