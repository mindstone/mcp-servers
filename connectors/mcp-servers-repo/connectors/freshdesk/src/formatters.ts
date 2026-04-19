/**
 * Response formatting helpers for Freshdesk ticket data.
 */

import type { FreshdeskTicket, FreshdeskConversation, FreshdeskTicketField } from './types.js';
import { statusToString, priorityToString, sourceToString } from './types.js';

export function ticketUrl(domain: string, ticketId: number): string {
  return `https://${domain}.freshdesk.com/a/tickets/${ticketId}`;
}

export function formatTicketConcise(ticket: FreshdeskTicket, domain: string): string {
  const status = statusToString(ticket.status);
  const priority = priorityToString(ticket.priority);
  return `#${ticket.id}: ${ticket.subject} [${status}] (${priority}) — ${ticketUrl(domain, ticket.id)}`;
}

export function formatTicketDetailed(ticket: FreshdeskTicket, domain: string): string {
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
    ticket.description_text ? `Description:\n${ticket.description_text}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function formatConversation(conv: FreshdeskConversation): string {
  const type = conv.private ? 'Internal note' : conv.incoming ? 'Customer reply' : 'Agent reply';
  const preview = (conv.body_text || conv.body || '').slice(0, 200);
  const truncated = (conv.body_text || conv.body || '').length > 200 ? '...' : '';
  return `[${conv.created_at}] ${type} (User ${conv.user_id}):\n${preview}${truncated}`;
}

export function formatTicketField(field: FreshdeskTicketField): string {
  const required = field.required_for_agents ? ' [required for agents]' : '';
  const closure = field.required_for_closure ? ' [required for closure]' : '';
  return `${field.label} (ID: ${field.id}, name: ${field.name}, type: ${field.type})${required}${closure}`;
}
