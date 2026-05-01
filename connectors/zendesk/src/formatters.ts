import type {
  FormatOptions,
  ZendeskTicket,
  ZendeskComment,
  ZendeskUser,
  ZendeskGroup,
  ZendeskTicketField,
  ZendeskMacro,
} from './types.js';

// ---------------------------------------------------------------------------
// Untrusted-content envelope helpers (M3.5b)
//
// Body content returned by Zendesk (ticket descriptions, comment bodies,
// search-result subjects/descriptions) is third-party text that an end-user
// or external requester wrote. We wrap it in <untrusted-content
// source="external-ticket">...</untrusted-content> so the host LLM can
// recognise it as data, not instructions. Connector-controlled metadata
// (ids, statuses, priorities, requester ids, timestamps) is NEVER wrapped.
// ---------------------------------------------------------------------------

export const UNTRUSTED_TICKET_OPEN = '<untrusted-content source="external-ticket">';
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

/**
 * Wrap a body string in the external-ticket envelope. Returns `undefined`
 * for null/undefined/non-string/empty input so callers can skip the field
 * entirely rather than emit an empty envelope.
 */
export function wrapUntrustedTicketContent(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined) return undefined;
  if (typeof s !== 'string') return undefined;
  if (s.length === 0) return undefined;
  return `${UNTRUSTED_TICKET_OPEN}${s}${UNTRUSTED_TICKET_CLOSE}`;
}

/**
 * Return a shallow clone of the ticket with the `description` field wrapped.
 * Used by `get_zendesk_ticket` (where the LLM-facing surface is the ticket
 * body rather than the subject, which the connector may itself reference).
 * Metadata (id, status, priority, requester_id, timestamps, tags...) is left
 * untouched.
 */
export function wrapTicketBodyFields(ticket: ZendeskTicket): ZendeskTicket {
  const wrapped: ZendeskTicket = { ...ticket };
  const wd = wrapUntrustedTicketContent(ticket.description);
  if (wd !== undefined) wrapped.description = wd;
  return wrapped;
}

/**
 * Return a shallow clone of the ticket with the body fields wrapped for
 * consumption by `search_zendesk_tickets`. Subjects are wrapped because
 * search results carry attacker-controlled subject text directly (e.g.
 * matches on `subject:` queries). Descriptions are wrapped where present.
 */
export function wrapTicketBodyFieldsForSearch(ticket: ZendeskTicket): ZendeskTicket {
  const wrapped: ZendeskTicket = { ...ticket };
  const ws = wrapUntrustedTicketContent(ticket.subject);
  if (ws !== undefined) wrapped.subject = ws;
  const wd = wrapUntrustedTicketContent(ticket.description);
  if (wd !== undefined) wrapped.description = wd;
  return wrapped;
}

/**
 * Return a shallow clone of the comment with body fields wrapped. Wraps
 * `body`, and (when present) the optional `html_body` / `plain_body`
 * fields the Zendesk REST API may return for HTML/plain renderings.
 */
export function wrapCommentBodyFields<
  T extends ZendeskComment & { html_body?: string | null; plain_body?: string | null }
>(comment: T): T {
  const wrapped: T = { ...comment };
  const wb = wrapUntrustedTicketContent(comment.body);
  if (wb !== undefined) wrapped.body = wb;
  const maybeHtml = (comment as { html_body?: string | null }).html_body;
  if (maybeHtml !== undefined) {
    const wh = wrapUntrustedTicketContent(maybeHtml);
    if (wh !== undefined) {
      (wrapped as { html_body?: string }).html_body = wh;
    }
  }
  const maybePlain = (comment as { plain_body?: string | null }).plain_body;
  if (maybePlain !== undefined) {
    const wp = wrapUntrustedTicketContent(maybePlain);
    if (wp !== undefined) {
      (wrapped as { plain_body?: string }).plain_body = wp;
    }
  }
  return wrapped;
}

export function formatTicket(ticket: ZendeskTicket, options: FormatOptions = {}): string {
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

export function formatUser(user: ZendeskUser, options: FormatOptions = {}): string {
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

export function formatGroup(group: ZendeskGroup): string {
  return `${group.name} (ID: ${group.id})`;
}

export function formatTicketField(field: ZendeskTicketField): string {
  const required = field.required ? ' [required]' : '';
  return `${field.title} (ID: ${field.id}, type: ${field.type})${required}`;
}

export function formatMacro(macro: ZendeskMacro, options: FormatOptions = {}): string {
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
