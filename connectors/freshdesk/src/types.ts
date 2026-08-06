export const REQUEST_TIMEOUT_MS = 30_000;

export interface BridgeState {
  port: number;
  token: string;
}

export class FreshdeskError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly resolution: string,
  ) {
    super(message);
    this.name = 'FreshdeskError';
  }
}

// ---------------------------------------------------------------------------
// Freshdesk API types
// ---------------------------------------------------------------------------

export interface AccountInfo {
  domain: string;
  apiKey: string;
  agentEmail?: string;
  authenticatedAt?: string;
}

export interface AccountsConfig {
  accounts: AccountInfo[];
  defaultDomain?: string;
}

export interface FreshdeskAccount {
  domain: string;
  apiKey: string;
  agentEmail?: string;
}

export interface FreshdeskTicket {
  id: number;
  subject: string;
  description?: string;
  description_text?: string;
  status: number;
  priority: number;
  source: number;
  type?: string;
  requester_id: number;
  responder_id?: number;
  group_id?: number;
  email?: string;
  created_at: string;
  updated_at: string;
  due_by?: string;
  tags?: string[];
  custom_fields?: Record<string, unknown>;
  fr_escalated?: boolean;
  spam?: boolean;
  is_escalated?: boolean;
}

export interface FreshdeskConversation {
  id: number;
  body: string;
  body_text?: string;
  incoming: boolean;
  private: boolean;
  user_id: number;
  from_email?: string;
  to_emails?: string[];
  created_at: string;
  updated_at: string;
  source: number;
}

export interface FreshdeskTicketField {
  id: number;
  name: string;
  label: string;
  description?: string;
  type: string;
  required_for_closure: boolean;
  required_for_agents: boolean;
  default: boolean;
  position: number;
  choices?: Record<string, unknown> | Array<string | [string, string]>;
}

export interface FreshdeskAgent {
  id: number;
  available?: boolean;
  occasional?: boolean;
  signature?: string;
  ticket_scope?: number;
  group_ids?: number[];
  role_ids?: number[];
  contact?: {
    name?: string;
    email?: string;
    phone?: string;
    mobile?: string;
  };
  created_at?: string;
  updated_at?: string;
}

export interface FreshdeskGroup {
  id: number;
  name: string;
  description?: string;
  escalate_to?: number;
  unassigned_for?: string;
  business_hour_id?: number;
  group_type?: string;
  agent_ids?: number[];
  created_at?: string;
  updated_at?: string;
}

export interface FreshdeskContact {
  id: number;
  name?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  twitter_id?: string;
  job_title?: string;
  company_id?: number;
  description?: string;
  address?: string;
  tags?: string[];
  active?: boolean;
  deleted?: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface FreshdeskCompany {
  id: number;
  name: string;
  description?: string;
  note?: string;
  domains?: string[];
  industry?: string;
  tier?: string;
  health_score?: string;
  account_tier?: string;
  renewal_date?: string;
  created_at?: string;
  updated_at?: string;
}

export interface FreshdeskSolutionArticle {
  id: number;
  title: string;
  description?: string;
  description_text?: string;
  status?: number; // 1 = draft, 2 = published
  folder_id?: number;
  category_id?: number;
  thumbs_up?: number;
  thumbs_down?: number;
  hits?: number;
  tags?: string[];
  created_at?: string;
  updated_at?: string;
}

// ---------------------------------------------------------------------------
// Status / Priority / Source maps
// ---------------------------------------------------------------------------

export const STATUS_MAP: Record<number, string> = {
  2: 'Open',
  3: 'Pending',
  4: 'Resolved',
  5: 'Closed',
};

export const PRIORITY_MAP: Record<number, string> = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

export const SOURCE_MAP: Record<number, string> = {
  1: 'Email',
  2: 'Portal',
  3: 'Phone',
  7: 'Chat',
  8: 'Feedback Widget',
  9: 'Outbound Email',
};

export function statusToString(status: number): string {
  if (STATUS_MAP[status]) return STATUS_MAP[status];
  // Fail-closed: only a finite number is interpolated into the fallback
  // label — a non-number value (API shape violation) never reaches
  // model-visible output raw.
  return typeof status === 'number' && Number.isFinite(status) ? `Custom (${status})` : 'Unknown';
}

export function priorityToString(priority: number): string {
  if (PRIORITY_MAP[priority]) return PRIORITY_MAP[priority];
  return typeof priority === 'number' && Number.isFinite(priority)
    ? `Unknown (${priority})`
    : 'Unknown';
}

export function sourceToString(source: number): string {
  if (SOURCE_MAP[source]) return SOURCE_MAP[source];
  return typeof source === 'number' && Number.isFinite(source) ? `Unknown (${source})` : 'Unknown';
}

/**
 * Parse a status value that may be a number or a human-readable string.
 *
 * Fail-closed: returns `undefined` for anything that is not a positive
 * integer (Freshdesk custom statuses have numeric ids beyond the defaults)
 * or an exact default-status name. Callers performing writes MUST reject
 * `undefined` instead of silently omitting the field. Numeric strings must
 * be all digits — `parseInt` alone would silently coerce `"3garbage"` to 3.
 */
export function parseStatus(input: unknown): number | undefined {
  if (typeof input === 'number') {
    return Number.isInteger(input) && input > 0 ? input : undefined;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      return parseInt(trimmed, 10);
    }
    const lower = trimmed.toLowerCase();
    for (const [key, value] of Object.entries(STATUS_MAP)) {
      if (value.toLowerCase() === lower) return parseInt(key, 10);
    }
  }
  return undefined;
}

/**
 * Parse a priority value that may be a number or a human-readable string.
 *
 * Fail-closed: Freshdesk priorities are a fixed set (1-4), so anything else
 * returns `undefined`. Callers performing writes MUST reject `undefined`
 * instead of silently omitting the field.
 */
export function parsePriority(input: unknown): number | undefined {
  if (typeof input === 'number') {
    return Number.isInteger(input) && PRIORITY_MAP[input] !== undefined ? input : undefined;
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (/^\d+$/.test(trimmed)) {
      const num = parseInt(trimmed, 10);
      return PRIORITY_MAP[num] !== undefined ? num : undefined;
    }
    const lower = trimmed.toLowerCase();
    for (const [key, value] of Object.entries(PRIORITY_MAP)) {
      if (value.toLowerCase() === lower) return parseInt(key, 10);
    }
  }
  return undefined;
}
