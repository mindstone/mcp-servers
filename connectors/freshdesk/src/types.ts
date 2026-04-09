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
  return STATUS_MAP[status] || `Custom (${status})`;
}

export function priorityToString(priority: number): string {
  return PRIORITY_MAP[priority] || `Unknown (${priority})`;
}

export function sourceToString(source: number): string {
  return SOURCE_MAP[source] || `Unknown (${source})`;
}

/**
 * Parse a status value that may be a number or a human-readable string.
 */
export function parseStatus(input: unknown): number | undefined {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const num = parseInt(input, 10);
    if (!isNaN(num)) return num;
    const lower = input.toLowerCase();
    for (const [key, value] of Object.entries(STATUS_MAP)) {
      if (value.toLowerCase() === lower) return parseInt(key, 10);
    }
  }
  return undefined;
}

/**
 * Parse a priority value that may be a number or a human-readable string.
 */
export function parsePriority(input: unknown): number | undefined {
  if (typeof input === 'number') return input;
  if (typeof input === 'string') {
    const num = parseInt(input, 10);
    if (!isNaN(num)) return num;
    const lower = input.toLowerCase();
    for (const [key, value] of Object.entries(PRIORITY_MAP)) {
      if (value.toLowerCase() === lower) return parseInt(key, 10);
    }
  }
  return undefined;
}
