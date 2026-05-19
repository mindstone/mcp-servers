export interface MicrosoftAccount {
  email: string;
  displayName?: string;
  tenantId?: string;
}

export interface AccountsConfig {
  accounts: MicrosoftAccount[];
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function successResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
    isError: true,
  };
}

/**
 * Reasons an auth_required envelope can be emitted. Slack uses the same vocabulary.
 */
export type AuthRequiredReason = 'token_expired' | 'not_connected' | 'consent_required' | 'tenant_blocked';

export interface AuthRequiredOptions {
  package_id: string;
  auth_tool: string;
  reason: AuthRequiredReason;
  error?: string;
  resolution?: string;
}

/**
 * Emit a structured `auth_required` envelope matching Slack's contract
 * (resources/mcp/slack/src/index.ts § formatTokenExpiredError). Returning this
 * shape lets the desktop app's auth-recovery layer detect the failure mode,
 * surface the right re-auth UI, and trigger the named `auth_tool` without
 * pattern-matching free-text errors.
 *
 * Shape:
 *   { ok: false,
 *     action: 'auth_required',
 *     package_id, auth_tool, reason, error, resolution?,
 *     next_step: { tool: auth_tool } }
 */
export function formatAuthRequiredError(opts: AuthRequiredOptions): ToolResult {
  const payload: Record<string, unknown> = {
    ok: false,
    action: 'auth_required',
    package_id: opts.package_id,
    auth_tool: opts.auth_tool,
    reason: opts.reason,
    error: opts.error ?? defaultAuthErrorMessage(opts.reason),
    next_step: { tool: opts.auth_tool },
  };
  if (opts.resolution) payload.resolution = opts.resolution;
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}

function defaultAuthErrorMessage(reason: AuthRequiredReason): string {
  switch (reason) {
    case 'token_expired':
      return 'Microsoft access token has expired or been revoked.';
    case 'not_connected':
      return 'Microsoft account is not connected.';
    case 'consent_required':
      return 'Additional admin consent is required for this Microsoft account.';
    case 'tenant_blocked':
      return 'Your Microsoft tenant is blocking this request.';
  }
}

/**
 * Classify a Graph error / caught error into an auth-required reason.
 * Returns null when the failure is not auth-related (caller falls back to
 * `errorResult(formatGraphError(err))`).
 */
export function detectAuthRequiredReason(err: unknown): AuthRequiredReason | null {
  if (!(err instanceof Error)) return null;
  const graphErr = err as Error & { statusCode?: number; code?: string };
  const statusCode = graphErr.statusCode;
  const code = (graphErr.code ?? '').toLowerCase();
  const msg = err.message.toLowerCase();

  if (statusCode === 401) return 'token_expired';
  if (code.includes('invalidauthenticationtoken') || code.includes('tokenexpired')) return 'token_expired';
  if (msg.includes('token has expired') || msg.includes('invalid_grant')) return 'token_expired';
  if (msg.includes('account not connected') || msg.includes('account not authenticated')) return 'not_connected';
  if (statusCode === 403 && (code.includes('consent') || msg.includes('consent'))) return 'consent_required';
  if (statusCode === 403 && msg.includes('tenant')) return 'tenant_blocked';
  return null;
}

export function formatGraphError(err: unknown): string {
  if (err instanceof Error) {
    const graphErr = err as Error & { statusCode?: number; code?: string; body?: string; requestUrl?: string };
    const statusCode = graphErr.statusCode;
    const code = graphErr.code;

    // Try to extract the Graph API error body for actionable details
    let graphMessage = '';
    if (graphErr.body) {
      try {
        const parsed = JSON.parse(graphErr.body);
        const innerError = parsed?.error;
        if (innerError?.message) {
          graphMessage = innerError.message;
        }
      } catch {
        // body is not JSON — ignore
      }
    }

    const message = graphMessage || err.message || '';

    if (statusCode === 401) {
      return `Microsoft authentication failed (HTTP 401${code ? `: ${code}` : ''}). Token may have expired — please reconnect your Microsoft account.`;
    }
    if (statusCode === 403) {
      const detail = message || 'Access denied';
      return `${detail} (HTTP 403${code ? `: ${code}` : ''}). Your IT admin may need to approve additional permissions for this application, or try disconnecting and reconnecting your Microsoft account.`;
    }
    if (message) {
      return statusCode ? `${message} (HTTP ${statusCode})` : message;
    }
    if (statusCode) {
      return `Microsoft Graph API error (HTTP ${statusCode}${code ? `: ${code}` : ''})`;
    }
    return 'Unknown error';
  }
  return String(err) || 'Unknown error';
}

export interface PaginatedResponse<T> {
  value: T[];
  '@odata.nextLink'?: string;
  '@odata.count'?: number;
}

export interface EmailMessage {
  id: string;
  subject: string;
  from?: { emailAddress: { address: string; name?: string } };
  toRecipients?: Array<{ emailAddress: { address: string; name?: string } }>;
  receivedDateTime: string;
  bodyPreview?: string;
  body?: { content: string; contentType: string };
  isRead?: boolean;
  hasAttachments?: boolean;
  importance?: string;
  parentFolderId?: string;
}

export interface CalendarEvent {
  id: string;
  subject: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  location?: { displayName: string };
  attendees?: Array<{
    emailAddress: { address: string; name?: string };
    status?: { response: string };
  }>;
  body?: { content: string; contentType: string };
  isAllDay?: boolean;
  organizer?: { emailAddress: { address: string; name?: string } };
  webLink?: string;
}

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  webUrl?: string;
  folder?: { childCount: number };
  file?: { mimeType: string };
  parentReference?: { path: string; id: string };
}

export interface Chat {
  id: string;
  topic?: string;
  chatType: 'oneOnOne' | 'group' | 'meeting';
  createdDateTime?: string;
  lastUpdatedDateTime?: string;
  members?: Array<{ displayName: string; email?: string }>;
}

export interface ChatMessage {
  id: string;
  body: { content: string; contentType: string };
  from?: { user?: { displayName: string; id: string } };
  createdDateTime: string;
}

export interface MailFolder {
  id: string;
  displayName: string;
  parentFolderId?: string;
  childFolderCount?: number;
  totalItemCount?: number;
  unreadItemCount?: number;
}

export interface Calendar {
  id: string;
  name: string;
  color?: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
  owner?: { name: string; address: string };
}

export interface SharePointSite {
  id: string;
  displayName: string;
  name: string;
  webUrl: string;
  description?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  root?: Record<string, unknown>;
  siteCollection?: { hostname: string };
}

export interface SharePointDrive {
  id: string;
  name: string;
  description?: string;
  driveType: string;
  webUrl?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  quota?: {
    total?: number;
    used?: number;
    remaining?: number;
    state?: string;
  };
}

export const SHAREPOINT_REQUIRED_SCOPE = 'Sites.Read.All';

/**
 * Check if a scope string contains a required scope (case-insensitive).
 * Handles space-delimited scope strings from Microsoft OAuth tokens.
 */
export function hasScope(scopeString: string | undefined, requiredScope: string): boolean {
  if (!scopeString) return false;
  const scopes = scopeString.toLowerCase().split(/\s+/);
  return scopes.includes(requiredScope.toLowerCase());
}
