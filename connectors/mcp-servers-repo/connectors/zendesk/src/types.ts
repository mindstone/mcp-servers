export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
export const REQUEST_TIMEOUT_MS = 30_000;
export const SUBDOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i;

export const MAX_TICKETS_WITH_COMMENTS = 200;
export const MAX_IDS_IN_CONTEXT = 100;
export const MAX_COMMENTS_PER_TICKET = 500;
export const MAX_COMMENTS_PER_TICKET_BULK = 100;

export interface TokenData {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  expires_at: number;
  token_type: string;
  subdomain: string;
  email?: string;
}

export interface AccountInfo {
  subdomain: string;
  email: string;
  apiToken?: string;
}

export interface AccountsConfig {
  accounts: AccountInfo[];
  defaultSubdomain?: string;
}

export interface ZendeskAccount {
  subdomain: string;
  email?: string;
  apiToken?: string;
  authType: 'api-token' | 'oauth';
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface BridgeState {
  port: number;
  token: string;
}

export interface FormatOptions {
  format?: 'concise' | 'detailed';
}

export interface ZendeskTicket {
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

export interface ZendeskUser {
  id: number;
  name: string;
  email: string;
  role: string;
  active: boolean;
  created_at: string;
  phone?: string;
  organization_id?: number;
}

export interface ZendeskGroup {
  id: number;
  name: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

export interface ZendeskTicketField {
  id: number;
  type: string;
  title: string;
  description?: string;
  required: boolean;
  active: boolean;
  position: number;
  custom_field_options?: Array<{ name: string; value: string }>;
}

export interface ZendeskComment {
  id: number;
  body: string;
  author_id: number;
  created_at: string;
  public: boolean;
}

export interface ZendeskView {
  id: number;
  title: string;
  active: boolean;
  position: number;
  restriction?: {
    type: string;
    id?: number;
  };
}

export interface ZendeskOrganization {
  id: number;
  name: string;
  domain_names?: string[];
  created_at: string;
  updated_at: string;
  details?: string;
  notes?: string;
}

export interface ZendeskMacro {
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

export interface ZendeskMacroApplyResult {
  result: {
    ticket: Record<string, unknown>;
  };
}

export interface ZendeskFetchOptions extends RequestInit {
  params?: Record<string, string | number | boolean | undefined>;
}

export class ZendeskError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string
  ) {
    super(message);
    this.name = 'ZendeskError';
  }
}

export function assertValidSubdomain(subdomain: string): void {
  if (!SUBDOMAIN_RE.test(subdomain)) {
    throw new Error(`Invalid Zendesk subdomain: ${subdomain}`);
  }
}
