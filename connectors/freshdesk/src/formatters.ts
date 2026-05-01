/**
 * Response formatting helpers for Freshdesk ticket data.
 */

import type { FreshdeskTicket, FreshdeskConversation, FreshdeskTicketField } from './types.js';
import { statusToString, priorityToString, sourceToString } from './types.js';

// ---------------------------------------------------------------------------
// Untrusted-content envelope helpers (M3.5a)
//
// Body content returned by Freshdesk (ticket descriptions, conversation
// bodies, search-result subjects/bodies) is third-party text that an end-user
// or external requester wrote. We wrap it in <untrusted-content
// source="external-ticket">...</untrusted-content> so the host LLM can
// recognise it as data, not instructions. Connector-controlled metadata
// (ids, statuses, priorities, timestamps, URLs) is NEVER wrapped.
// ---------------------------------------------------------------------------

export const UNTRUSTED_TICKET_OPEN = '<untrusted-content source="external-ticket">';
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

// Match any close-tag variant of the `<untrusted-content>` envelope:
// case-insensitive, optional whitespace (space or tab) before `>`. Used to
// neutralise attacker-supplied close tags inside body content before
// concatenation with the open/close sentinels — see VAL-FRESHDESK-007 /
// VAL-CROSS-011 / VAL-CROSS-012.
const UNTRUSTED_CLOSE_TAG_VARIANT = /<\/untrusted-content[ \t]*>/gi;
const ESCAPED_UNTRUSTED_CLOSE_TAG = '<\\/untrusted-content>';

function escapeCloseTagSentinels(s: string): string {
  return s.replace(UNTRUSTED_CLOSE_TAG_VARIANT, ESCAPED_UNTRUSTED_CLOSE_TAG);
}

/**
 * Wrap a body string in the external-ticket envelope. Returns `undefined`
 * for null/undefined/empty input so callers can skip the field entirely
 * rather than emit an empty envelope.
 *
 * Any `</untrusted-content>` (and case / whitespace variants) embedded in
 * `s` is rewritten to a benign textual form before concatenation, so an
 * attacker controlling ticket content cannot break out of the envelope.
 *
 * Idempotent: when `s` is already a properly-shaped envelope (starts with
 * OPEN, ends with CLOSE, and contains no internal close-tag variants),
 * the original string is returned unchanged so `wrap(wrap(s)) === wrap(s)`.
 */
export function wrapUntrustedTicketContent(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined) return undefined;
  if (typeof s !== 'string') return undefined;
  if (s.length === 0) return undefined;
  if (
    s.startsWith(UNTRUSTED_TICKET_OPEN) &&
    s.endsWith(UNTRUSTED_TICKET_CLOSE)
  ) {
    const inner = s.slice(
      UNTRUSTED_TICKET_OPEN.length,
      s.length - UNTRUSTED_TICKET_CLOSE.length,
    );
    if (!/<\/untrusted-content[ \t]*>/i.test(inner)) {
      return s;
    }
  }
  return `${UNTRUSTED_TICKET_OPEN}${escapeCloseTagSentinels(s)}${UNTRUSTED_TICKET_CLOSE}`;
}

/**
 * Return a shallow clone of the ticket with body fields wrapped for
 * consumption by `search_freshdesk_tickets`. Subjects, descriptions
 * (HTML and text) are wrapped; metadata is left untouched.
 */
export function wrapTicketBodyFieldsForSearch(ticket: FreshdeskTicket): FreshdeskTicket {
  const wrapped: FreshdeskTicket = { ...ticket };
  const ws = wrapUntrustedTicketContent(ticket.subject);
  if (ws !== undefined) wrapped.subject = ws;
  const wd = wrapUntrustedTicketContent(ticket.description);
  if (wd !== undefined) wrapped.description = wd;
  const wdt = wrapUntrustedTicketContent(ticket.description_text);
  if (wdt !== undefined) wrapped.description_text = wdt;
  return wrapped;
}

export function ticketUrl(domain: string, ticketId: number): string {
  return `https://${domain}.freshdesk.com/a/tickets/${ticketId}`;
}

export function formatTicketConcise(ticket: FreshdeskTicket, domain: string): string {
  const status = statusToString(ticket.status);
  const priority = priorityToString(ticket.priority);
  return `#${ticket.id}: ${ticket.subject} [${status}] (${priority}) — ${ticketUrl(domain, ticket.id)}`;
}

/**
 * Concise formatter for `search_freshdesk_tickets` — wraps the subject in the
 * untrusted-content envelope because, unlike the listing/get cases, search
 * results carry attacker-controlled subject text directly (e.g. matches on
 * `subject:` queries).
 */
export function formatSearchResultConcise(ticket: FreshdeskTicket, domain: string): string {
  const status = statusToString(ticket.status);
  const priority = priorityToString(ticket.priority);
  const subject = wrapUntrustedTicketContent(ticket.subject) ?? ticket.subject;
  return `#${ticket.id}: ${subject} [${status}] (${priority}) — ${ticketUrl(domain, ticket.id)}`;
}

export function formatTicketDetailed(ticket: FreshdeskTicket, domain: string): string {
  const wrappedHtml = wrapUntrustedTicketContent(ticket.description);
  const wrappedText = wrapUntrustedTicketContent(ticket.description_text);
  return [
    `Ticket #${ticket.id}`,
    `URL: ${ticketUrl(domain, ticket.id)}`,
    `Subject: ${ticket.subject}`,
    `Status: ${statusToString(ticket.status)} (${ticket.status})`,
    `Priority: ${priorityToString(ticket.priority)} (${ticket.priority})`,
    `Source: ${sourceToString(ticket.source)}`,
    ticket.type ? `Type: ${ticket.type}` : '',
    `Requester ID: ${ticket.requester_id}`,
    ticket.email ? `Requester Email: ${ticket.email}` : '',
    ticket.responder_id ? `Assignee ID: ${ticket.responder_id}` : 'Assignee: unassigned',
    ticket.group_id ? `Group ID: ${ticket.group_id}` : '',
    `Created: ${ticket.created_at}`,
    `Updated: ${ticket.updated_at}`,
    ticket.due_by ? `Due by: ${ticket.due_by}` : '',
    ticket.tags && ticket.tags.length > 0 ? `Tags: ${ticket.tags.join(', ')}` : '',
    wrappedHtml ? `Description (HTML):\n${wrappedHtml}` : '',
    wrappedText ? `Description (text):\n${wrappedText}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatConversation(conv: FreshdeskConversation): string {
  const type = conv.private ? 'Internal note' : conv.incoming ? 'Customer reply' : 'Agent reply';
  const wrappedHtml = wrapUntrustedTicketContent(conv.body);
  const wrappedText = wrapUntrustedTicketContent(conv.body_text);
  const lines: string[] = [`[${conv.created_at}] ${type} (User ${conv.user_id}):`];
  if (wrappedHtml) lines.push(`Body (HTML): ${wrappedHtml}`);
  if (wrappedText) lines.push(`Body (text): ${wrappedText}`);
  return lines.join('\n');
}

export function formatTicketField(field: FreshdeskTicketField): string {
  const required = field.required_for_agents ? ' [required for agents]' : '';
  const closure = field.required_for_closure ? ' [required for closure]' : '';
  return `${field.label} (ID: ${field.id}, name: ${field.name}, type: ${field.type})${required}${closure}`;
}
