/**
 * Response formatting helpers for Freshdesk API data.
 *
 * Text returned by Freshdesk (ticket subjects/descriptions, conversation
 * bodies, contact names, KB article content, …) is third-party text that an
 * end-user or external requester may have written. It is wrapped in
 * `<untrusted-content source="…">…</untrusted-content>` envelopes via the
 * canonical shared helper (vendored at `./untrusted-content.ts`) so the host
 * LLM treats it as data, not instructions. Connector-controlled metadata
 * (ids, statuses, priorities, timestamps, URLs) is NEVER wrapped.
 */

import type { FreshdeskTicket, FreshdeskConversation, FreshdeskTicketField } from './types.js';
import { statusToString, priorityToString, sourceToString } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';

export const UNTRUSTED_TICKET_OPEN = '<untrusted-content source="external-ticket">';
export const UNTRUSTED_TICKET_CLOSE = '</untrusted-content>';

const TICKET_SOURCE = 'external-ticket';

/**
 * Wrap a body string in the external-ticket envelope using the canonical
 * shared helper. Returns `undefined` for null/undefined/empty input so
 * callers can skip the field entirely rather than emit an empty envelope.
 *
 * Any `</untrusted-content>` variant (case / whitespace) embedded in `s` is
 * rewritten to a benign textual form before concatenation, so an attacker
 * controlling ticket content cannot break out of the envelope. Idempotent
 * for the same source: `wrap(wrap(s)) === wrap(s)`.
 */
export function wrapUntrustedTicketContent(s: string | null | undefined): string | undefined {
  if (typeof s !== 'string' || s.length === 0) return undefined;
  return wrapUntrusted(s, TICKET_SOURCE);
}

/**
 * Return a shallow clone of the ticket with attacker-controlled text fields
 * (subject, HTML and text descriptions) enveloped; connector-controlled
 * metadata is left untouched.
 */
export function wrapTicketUntrustedFields(ticket: FreshdeskTicket): FreshdeskTicket {
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
  const subject = wrapUntrustedTicketContent(ticket.subject) ?? ticket.subject;
  return `#${ticket.id}: ${subject} [${status}] (${priority}) — ${ticketUrl(domain, ticket.id)}`;
}

export function formatTicketDetailed(ticket: FreshdeskTicket, domain: string): string {
  const wrappedSubject = wrapUntrustedTicketContent(ticket.subject) ?? ticket.subject;
  const wrappedHtml = wrapUntrustedTicketContent(ticket.description);
  const wrappedText = wrapUntrustedTicketContent(ticket.description_text);
  return [
    `Ticket #${ticket.id}`,
    `URL: ${ticketUrl(domain, ticket.id)}`,
    `Subject: ${wrappedSubject}`,
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
